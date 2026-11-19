const { getOldDb } = require('../db/oldDb');
const { getNewDb } = require('../db/newDb');
const { section, success, info, logError } = require('../utils/logger');
const { reportDone } = require('../utils/progress');
const { loadMap, saveMap } = require('../utils/maps');
const {
  forEachBatch,
  createId,
  shouldSaveMaps,
  DEFAULT_BATCH_SIZE,
} = require('../utils/batch');
const { bulkInsertWithFallback } = require('../utils/bulk');
const {
  decryptLegacy,
  decryptIfEncrypted,
  isValidEmail,
} = require('../utils/decrypt');
const { resolveEmail, resolvePhone } = require('../utils/contactFields');
const { normalizeLegacyFileRef } = require('../utils/legacyFiles');

const MAP_NAME = 'companyMap.json';
const EMPLOYER_INDEX_NAME = 'employerUserIndex.json';
const EMAIL_CLAIM_MAP_NAME = 'companyEmailClaimMap.json';

const COMPANY_COLS = [
  'id',
  'name',
  'email',
  'phone',
  '"registrationNo"',
  '"businessTypeId"',
  '"industryId"',
  '"provinceId"',
  '"cityId"',
  'address',
  '"contactPerson"',
  '"contactCnic"',
  '"logoKey"',
  '"isEducationInstitute"',
  '"isActive"',
  '"createdAt"',
  '"updatedAt"',
];

function decryptField(value) {
  if (value == null) return value;
  const s = String(value).trim();
  return s ? decryptLegacy(s) : s;
}

function companyEmail(value, oldId) {
  return resolveEmail(value, { migration: 'companies', oldId });
}

function companyPhone(value, oldId) {
  return resolvePhone(value, { migration: 'companies', oldId });
}

function normalizeName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, ' ');
}

function normalizeEmailKey(email) {
  if (email == null) return null;
  const s = String(email).trim().toLowerCase();
  return s || null;
}

/**
 * Build a stable email key for dedupe (decrypt first, then validate/normalize).
 * Encrypted legacy values that decrypt to the same address must collide.
 */
function emailKeyFromRaw(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const decrypted = decryptIfEncrypted(String(raw).trim());
  if (!isValidEmail(decrypted)) return null;
  return normalizeEmailKey(decrypted);
}

/** Old bigint IDs arrive as strings from node-pg; new lookup sets use numbers. */
function toIntId(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function loadLookups(newDb) {
  const [provinces, cities, businessTypes, industries] = await Promise.all([
    newDb.query('SELECT id, name FROM provinces'),
    newDb.query('SELECT id, name FROM cities'),
    newDb.query('SELECT id FROM business_types'),
    newDb.query('SELECT id FROM industries'),
  ]);

  const provinceByName = new Map();
  for (const row of provinces.rows) {
    provinceByName.set(normalizeName(row.name), row.id);
  }

  const cityByName = new Map();
  for (const row of cities.rows) {
    cityByName.set(normalizeName(row.name), row.id);
  }

  return {
    provinceByName,
    cityByName,
    businessTypeIds: new Set(businessTypes.rows.map((row) => Number(row.id))),
    industryIds: new Set(industries.rows.map((row) => Number(row.id))),
  };
}

function resolveProvinceAndCity(row, lookups) {
  let provinceId = null;
  if (row.province) {
    provinceId = lookups.provinceByName.get(normalizeName(row.province)) ?? null;
    if (provinceId == null) {
      logError({
        migration: 'companies',
        oldId: row.id,
        message: `No province match for "${row.province}"`,
        stack: null,
      });
    }
  }

  let cityId = null;
  if (row.city) {
    cityId = lookups.cityByName.get(normalizeName(row.city)) ?? null;
    if (cityId == null) {
      logError({
        migration: 'companies',
        oldId: row.id,
        message: `No city match for "${row.city}"`,
        stack: null,
      });
    }
  }

  return { provinceId, cityId };
}

function resolveBusinessTypeAndIndustry(row, lookups) {
  const rawBiz = toIntId(row.type_of_business_id);
  const businessTypeId =
    rawBiz != null && lookups.businessTypeIds.has(rawBiz) ? rawBiz : null;
  if (row.type_of_business_id != null && businessTypeId == null) {
    logError({
      migration: 'companies',
      oldId: row.id,
      message: `No business type match for id ${row.type_of_business_id}`,
      stack: null,
    });
  }

  const rawInd = toIntId(row.type_of_industry_id);
  const industryId =
    rawInd != null && lookups.industryIds.has(rawInd) ? rawInd : null;
  if (row.type_of_industry_id != null && industryId == null) {
    logError({
      migration: 'companies',
      oldId: row.id,
      message: `No industry match for id ${row.type_of_industry_id}`,
      stack: null,
    });
  }

  return { businessTypeId, industryId };
}

function companyNameFromOrg(row) {
  return (
    (row.head_of_department && String(row.head_of_department).trim()) ||
    (row.user_name && String(row.user_name).trim()) ||
    (row.point_of_contact && String(row.point_of_contact).trim()) ||
    `Organization ${row.id}`
  );
}

/**
 * Prefer the company that has an admin user (organization.user_id),
 * then the oldest created_at, then lowest id.
 */
function pickPreferredOrg(a, b) {
  const aAdmin = a.user_id != null ? 1 : 0;
  const bAdmin = b.user_id != null ? 1 : 0;
  if (aAdmin !== bAdmin) return aAdmin > bAdmin ? a : b;

  const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
  if (aTime !== bTime) return aTime <= bTime ? a : b;

  return Number(a.id) <= Number(b.id) ? a : b;
}

/**
 * Corporate client rules:
 * 1. industry must resolve (no null industryId)
 * 2. one company per email; prefer the one with admin user (user_id)
 * 3. industry rule wins over adminUser
 */
async function selectOrganizationWinners(oldDb, lookups) {
  const result = await oldDb.query(
    `SELECT
       o.id,
       o.user_id,
       o.created_at,
       o.type_of_business_id,
       o.type_of_industry_id,
       u.email AS user_email
     FROM organization o
     LEFT JOIN "user" u ON u.id = o.user_id
     ORDER BY o.id`
  );

  const eligible = [];
  let skippedNoIndustry = 0;

  for (const row of result.rows) {
    const { industryId } = resolveBusinessTypeAndIndustry(row, lookups);

    // Dedupe on decrypted email key (not ciphertext)
    const emailKey = emailKeyFromRaw(row.user_email);
    const email = emailKey ? companyEmail(row.user_email, row.id) : null;
    eligible.push({
      ...row,
      industryId,
      emailKey,
      resolvedEmail: email,
    });
  }

  /** @type {Map<string, typeof eligible[0]>} */
  const winnerByEmail = new Map();
  /** @type {typeof eligible} */
  const noEmailWinners = [];

  for (const row of eligible) {
    if (!row.emailKey) {
      noEmailWinners.push(row);
      continue;
    }
    const existing = winnerByEmail.get(row.emailKey);
    if (!existing) {
      winnerByEmail.set(row.emailKey, row);
      continue;
    }
    const preferred = pickPreferredOrg(existing, row);
    const rejected = preferred === existing ? row : existing;
    winnerByEmail.set(row.emailKey, preferred);
    logError({
      migration: 'companies',
      oldId: rejected.id,
      message: `Skipped duplicate company email "${row.emailKey}" — kept org ${preferred.id} (prefer adminUser)`,
      stack: null,
    });
  }

  const winners = [...winnerByEmail.values(), ...noEmailWinners];
  const winnerIds = new Set(winners.map((w) => String(w.id)));

  info(
    `Corporate filter: ${result.rows.length} orgs → ${winners.length} kept ` +
      `(skipped no-industry: ${skippedNoIndustry}, ` +
      `email duplicates removed: ${eligible.length - winners.length})`
  );

  return { winnerIds, skippedNoIndustry };
}

async function migrateOrganizationCompanies(
  oldDb,
  newDb,
  companyMap,
  employerUserIndex,
  lookups,
  emailClaimMap
) {
  let inserted = 0;
  let skipped = 0;
  let skippedFiltered = 0;

  const { winnerIds } = await selectOrganizationWinners(oldDb, lookups);

  // Also block emails already present in NEW DB (partial re-runs / old data)
  const existingEmails = await newDb.query(
    `SELECT lower(btrim(email)) AS email
     FROM companies
     WHERE email IS NOT NULL AND btrim(email) <> ''`
  );
  for (const row of existingEmails.rows) {
    if (row.email && !emailClaimMap[row.email]) {
      emailClaimMap[row.email] = '__existing__';
    }
  }

  await forEachBatch(
    async (lastId, limit) => {
      const result = await oldDb.query(
        `SELECT
           o.id,
           o.user_id,
           o.head_of_department,
           o.point_of_contact,
           o.province,
           o.city,
           o.address,
           o.organization_picture,
           o.created_at,
           o.type_of_business_id,
           o.type_of_industry_id,
           u.name AS user_name,
           u.email AS user_email,
           u.phone_number AS user_phone,
           u.cnic AS user_cnic,
           u.is_active AS user_is_active
         FROM organization o
         LEFT JOIN "user" u ON u.id = o.user_id
         WHERE o.id > $1
         ORDER BY o.id
         LIMIT $2`,
        [lastId, limit]
      );
      return result.rows;
    },
    async (rows, { batchIndex }) => {
      const toInsert = [];
      const now = new Date();

      for (const row of rows) {
        const oldId = String(row.id);
        if (companyMap[oldId]) {
          skipped += 1;
          if (row.user_id != null && !employerUserIndex[String(row.user_id)]) {
            employerUserIndex[String(row.user_id)] = companyMap[oldId];
          }
          continue;
        }

        if (!winnerIds.has(oldId)) {
          skippedFiltered += 1;
          continue;
        }

        const { provinceId, cityId } = resolveProvinceAndCity(row, lookups);
        const { businessTypeId, industryId } = resolveBusinessTypeAndIndustry(
          row,
          lookups
        );


        const emailKey = emailKeyFromRaw(row.user_email);
        const email = emailKey ? companyEmail(row.user_email, row.id) : null;
        if (emailKey) {
          if (emailClaimMap[emailKey] && emailClaimMap[emailKey] !== oldId) {
            skippedFiltered += 1;
            logError({
              migration: 'companies',
              oldId: row.id,
              message: `Skipped duplicate email "${emailKey}" — already claimed by ${emailClaimMap[emailKey]}`,
              stack: null,
            });
            continue;
          }
          emailClaimMap[emailKey] = oldId;
        }

        const newId = createId();
        toInsert.push({
          id: row.id,
          oldId,
          newId,
          userId: row.user_id != null ? String(row.user_id) : null,
          values: [
            newId,
            companyNameFromOrg(row),
            email,
            companyPhone(row.user_phone, row.id),
            null,
            businessTypeId,
            industryId,
            provinceId,
            cityId,
            row.address || null,
            row.point_of_contact || null,
            decryptField(row.user_cnic) || null,
            // Legacy URL for now — convert to MinIO key via `npm run migrate:assets`
            normalizeLegacyFileRef(row.organization_picture),
            false,
            row.user_is_active !== false,
            row.created_at || now,
            row.created_at || now,
          ],
        });
      }

      if (toInsert.length === 0) return;

      const { succeeded } = await bulkInsertWithFallback(
        newDb,
        'companies',
        COMPANY_COLS,
        toInsert,
        {
          migration: 'companies',
          chunkSize: 1000,
          toValues: (item) => item.values,
          onSuccess: (chunk) => {
            for (const item of chunk) {
              companyMap[item.oldId] = item.newId;
              if (item.userId) employerUserIndex[item.userId] = item.newId;
            }
          },
        }
      );

      inserted += succeeded;
      if (shouldSaveMaps(batchIndex)) {
        saveMap(MAP_NAME, companyMap);
        saveMap(EMPLOYER_INDEX_NAME, employerUserIndex);
        saveMap(EMAIL_CLAIM_MAP_NAME, emailClaimMap);
      }
    },
    { size: DEFAULT_BATCH_SIZE }
  );

  return { inserted, skipped, skippedFiltered };
}

/**
 * Household/individual employers: users in user_worker_employment who have NO
 * row in the organization table.  Create a personal "consumer-style" company
 * for each so their workers can be linked.
 */
async function migrateHouseholdEmployerCompanies(
  oldDb,
  newDb,
  companyMap,
  employerUserIndex,
  emailClaimMap
) {
  section('Migrating Household Employer Companies...');

  let inserted = 0;
  let skipped = 0;

  await forEachBatch(
    async (lastId, limit) => {
      const result = await oldDb.query(
        `SELECT DISTINCT ON (e.user_id)
           e.user_id,
           u.name,
           u.email,
           u.phone_number,
           u.cnic,
           u.created_at
         FROM user_worker_employment e
         INNER JOIN "user" u ON u.id = e.user_id
         WHERE NOT EXISTS (
           SELECT 1 FROM organization o WHERE o.user_id = e.user_id
         )
         AND e.user_id > $1
         ORDER BY e.user_id
         LIMIT $2`,
        [lastId, limit]
      );
      return result.rows;
    },
    async (rows, { batchIndex }) => {
      const toInsert = [];
      const now = new Date();

      for (const row of rows) {
        const odlUserId = String(row.user_id);
        if (employerUserIndex[odlUserId]) {
          skipped += 1;
          continue;
        }

        const name =
          (row.name && String(row.name).trim()) || `User ${row.user_id}`;
        const emailKey = emailKeyFromRaw(row.email);
        const email = emailKey ? companyEmail(row.email, `hh-${row.user_id}`) : null;

        if (emailKey) {
          if (emailClaimMap[emailKey] && emailClaimMap[emailKey] !== `hh-${row.user_id}`) {
            logError({
              migration: 'companies-household',
              oldId: row.user_id,
              message: `Skipped duplicate email "${emailKey}" — already claimed by ${emailClaimMap[emailKey]}`,
              stack: null,
            });
            continue;
          }
          emailClaimMap[emailKey] = `hh-${row.user_id}`;
        }

        const phone = companyPhone(row.phone_number, `hh-${row.user_id}`);
        const cnic = decryptField(row.cnic) || null;
        const createdAt = row.created_at || now;

        const newId = createId();
        toInsert.push({
          id: row.user_id,
          odlUserId,
          newId,
          values: [
            newId,
            name,
            email,
            phone,
            null,       // registrationNo
            null,       // businessTypeId
            null,       // industryId
            null,       // provinceId
            null,       // cityId
            null,       // address
            null,       // contactPerson
            cnic,       // contactCnic
            null,       // logoKey
            false,      // isEducationInstitute
            true,       // isActive
            createdAt,
            createdAt,
          ],
        });
      }

      if (toInsert.length === 0) return;

      const { succeeded } = await bulkInsertWithFallback(
        newDb,
        'companies',
        COMPANY_COLS,
        toInsert,
        {
          migration: 'companies-household',
          chunkSize: 1000,
          toValues: (item) => item.values,
          onSuccess: (chunk) => {
            for (const item of chunk) {
              companyMap[`hh-${item.id}`] = item.newId;
              employerUserIndex[item.odlUserId] = item.newId;
            }
          },
        }
      );

      inserted += succeeded;
      if (shouldSaveMaps(batchIndex)) {
        saveMap(MAP_NAME, companyMap);
        saveMap(EMPLOYER_INDEX_NAME, employerUserIndex);
        saveMap(EMAIL_CLAIM_MAP_NAME, emailClaimMap);
      }
    },
    { size: DEFAULT_BATCH_SIZE, idField: 'user_id' }
  );

  success(`Household employers: ${inserted} inserted, ${skipped} skipped`);
  return { inserted, skipped };
}

async function migrateCompanies() {
  section('Migrating Companies...');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap(MAP_NAME);
  const employerUserIndex = loadMap(EMPLOYER_INDEX_NAME);
  const emailClaimMap = loadMap(EMAIL_CLAIM_MAP_NAME);
  const lookups = await loadLookups(newDb);

  const orgs = await migrateOrganizationCompanies(
    oldDb,
    newDb,
    companyMap,
    employerUserIndex,
    lookups,
    emailClaimMap
  );
  const households = await migrateHouseholdEmployerCompanies(
    oldDb,
    newDb,
    companyMap,
    employerUserIndex,
    emailClaimMap
  );

  saveMap(MAP_NAME, companyMap);
  saveMap(EMPLOYER_INDEX_NAME, employerUserIndex);
  saveMap(EMAIL_CLAIM_MAP_NAME, emailClaimMap);

  reportDone('Companies', Object.keys(companyMap).length);
  if (orgs.skipped > 0) {
    success(`${orgs.skipped} organizations already mapped (skipped)`);
  }
  if (orgs.skippedFiltered > 0) {
    success(
      `${orgs.skippedFiltered} organizations excluded (no industry / duplicate email)`
    );
  }

  return {
    companyMap,
    employerUserIndex,
    inserted: orgs.inserted + households.inserted,
    skipped: orgs.skipped + households.skipped + orgs.skippedFiltered,
  };
}

module.exports = { migrateCompanies };
