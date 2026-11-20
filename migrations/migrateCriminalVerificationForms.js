const { getOldDb } = require('../db/oldDb');
const { getNewDb } = require('../db/newDb');
const { section, success, info, logError } = require('../utils/logger');
const { reportDone, reportProgress } = require('../utils/progress');
const { loadMap, saveMap } = require('../utils/maps');
const { createId, shouldSaveMaps } = require('../utils/batch');
const { bulkInsertWithFallback } = require('../utils/bulk');
const { decryptLegacy } = require('../utils/decrypt');
const { normalizeLegacyFileRef } = require('../utils/legacyFiles');

const FORM_MAP_NAME = 'criminalFormMap.json';
const TASK_MAP_NAME = 'verificationTaskMap.json';
const CPLC_MAP_NAME = 'cplcReviewMap.json';

const FORM_BATCH_SIZE = Number(process.env.CRIMINAL_FORM_BATCH_SIZE) || 500;
const FORM_BULK_CHUNK = Number(process.env.CRIMINAL_FORM_BULK_CHUNK) || 500;

const PLACEHOLDER_DOB = new Date('1900-01-01T00:00:00.000Z');
const PLACEHOLDER_CNIC_EXPIRY = new Date('2099-12-31T00:00:00.000Z');

function normStatus(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return s || null;
}

function mapFormResult(...statuses) {
  const values = statuses.map(normStatus).filter(Boolean);
  if (values.length === 0) return null;
  if (values.some((s) => /reject|fail|deni|criminal/.test(s))) {
    return 'CRIMINAL_RECORD';
  }
  if (values.some((s) => /approv|verif|complet|success|clear|pass|skip/.test(s))) {
    return 'CLEARED';
  }
  return null;
}

function mapCplcVerdict(status) {
  const s = normStatus(status);
  if (!s) return null;
  if (/reject|fail|deni/.test(s)) return 'REJECTED';
  if (/skip/.test(s)) return 'SKIPPED';
  if (/approv|verif|complet|success|clear|pass/.test(s)) return 'APPROVED';
  return null;
}

function strOr(value, fallback) {
  const s = value != null ? String(value).trim() : '';
  return s || fallback;
}

function normalizeName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, ' ');
}

function getPendingEmploymentIds(taskMap, formMap) {
  const ids = [];
  for (const oldId of Object.keys(taskMap)) {
    if (!formMap[oldId]) ids.push(Number(oldId));
  }
  ids.sort((a, b) => a - b);
  return ids;
}

async function loadCityProvinceLookups(newDb) {
  const [cities, provinces] = await Promise.all([
    newDb.query('SELECT id, name, "provinceId" FROM cities'),
    newDb.query('SELECT id FROM provinces'),
  ]);

  const cityIds = new Set();
  const cityByName = new Map();
  const provinceIdByCityId = new Map();
  let fallbackCityId = null;
  let fallbackProvinceId = null;
  for (const row of cities.rows) {
    cityIds.add(row.id);
    cityByName.set(normalizeName(row.name), row.id);
    provinceIdByCityId.set(row.id, row.provinceId);
    if (fallbackCityId == null) {
      fallbackCityId = row.id;
      fallbackProvinceId = row.provinceId;
    }
  }

  return {
    cityIds,
    cityByName,
    provinceIdByCityId,
    provinceIds: new Set(provinces.rows.map((row) => row.id)),
    fallbackCityId,
    fallbackProvinceId,
  };
}

function resolveCityProvince(row, lookups) {
  if (row.worker_city_id != null && lookups.cityIds.has(row.worker_city_id)) {
    const cityId = row.worker_city_id;
    const provinceId =
      row.worker_province_id != null && lookups.provinceIds.has(row.worker_province_id)
        ? row.worker_province_id
        : lookups.provinceIdByCityId.get(cityId) ?? null;
    if (provinceId != null) return { cityId, provinceId };
  }

  const employmentCity = row.employment_city ? String(row.employment_city).trim() : '';
  if (employmentCity) {
    const cityId = lookups.cityByName.get(normalizeName(employmentCity));
    if (cityId != null) {
      const provinceId = lookups.provinceIdByCityId.get(cityId) ?? null;
      if (provinceId != null) return { cityId, provinceId };
    }
  }

  return { cityId: null, provinceId: null };
}

async function loadEmploymentRows(oldDb, employmentIds) {
  if (!employmentIds.length) return [];

  const result = await oldDb.query(
    `SELECT
       e.id,
       e.full_name,
       e.father_name,
       e.address,
       e.city AS employment_city,
       e.cplc_verification_status,
       e.sindh_police_verification_status,
       e.islamabad_police_verification_status,
       e.verification_timestamp,
       e.registration_timestamp,
       w.cnic,
       w.date_of_birth,
       w.cnic_front_picture_link AS worker_cnic_front,
       w.cnic_back_picture_link AS worker_cnic_back,
       w.picture_link AS worker_face_photo,
       w.city_id AS worker_city_id,
       w.province_id AS worker_province_id
     FROM user_worker_employment e
     INNER JOIN worker w ON w.id = e.worker_id
     WHERE e.id = ANY($1::bigint[])
     ORDER BY e.id`,
    [employmentIds]
  );
  return result.rows;
}

/** One query per batch — avoids per-row LATERAL subqueries on the old DB. */
async function loadLatestDocsForEmployments(oldDb, employmentIds) {
  if (!employmentIds.length) return new Map();

  const result = await oldDb.query(
    `SELECT DISTINCT ON (d.user_worker_employment_id)
       d.user_worker_employment_id AS employment_id,
       d.cnic_front_picture_link,
       d.cnic_back_picture_link,
       d.picture_link
     FROM user_worker_employment_document d
     WHERE d.is_active IS DISTINCT FROM false
       AND d.user_worker_employment_id = ANY($1::bigint[])
     ORDER BY d.user_worker_employment_id, d.id DESC`,
    [employmentIds]
  );

  const map = new Map();
  for (const row of result.rows) {
    map.set(Number(row.employment_id), row);
  }
  return map;
}

async function migrateCriminalVerificationForms(systemUserId) {
  section('Migrating Criminal Verification Forms...');

  if (!systemUserId) {
    throw new Error('systemUserId is required for criminal form migration');
  }

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const formMap = loadMap(FORM_MAP_NAME);
  const taskMap = loadMap(TASK_MAP_NAME);
  const cplcMap = loadMap(CPLC_MAP_NAME);
  const lookups = await loadCityProvinceLookups(newDb);

  const pendingIds = getPendingEmploymentIds(taskMap, formMap);
  const sourceTotal = pendingIds.length;
  const alreadyMapped = Object.keys(formMap).length;

  info(`Batch size: ${FORM_BATCH_SIZE} (bulk insert chunks: ${FORM_BULK_CHUNK})`);
  if (alreadyMapped > 0) {
    info(`Resuming: ${alreadyMapped.toLocaleString()} forms already mapped`);
  }
  info(`Forms to migrate: ${sourceTotal.toLocaleString()} (from verification tasks)`);

  let formsInserted = 0;
  let formsSkipped = 0;
  let formsCityMissing = 0;
  let cplcInserted = 0;
  let processed = 0;
  let batchNum = 0;

  for (let offset = 0; offset < pendingIds.length; offset += FORM_BATCH_SIZE) {
    batchNum += 1;
    const batchIds = pendingIds.slice(offset, offset + FORM_BATCH_SIZE);

    const [rows, docMap] = await Promise.all([
      loadEmploymentRows(oldDb, batchIds),
      loadLatestDocsForEmployments(oldDb, batchIds),
    ]);

    processed += batchIds.length;

    const formRows = [];
    const cplcRows = [];
    const now = new Date();
    let batchSkipped = 0;
    let batchCityMissing = 0;
    let batchFormsAdded = 0;
    let batchCplcAdded = 0;

    for (const row of rows) {
      const oldId = String(row.id);
      if (formMap[oldId]) {
        formsSkipped += 1;
        batchSkipped += 1;
        continue;
      }

      const taskId = taskMap[oldId];
      if (!taskId) continue;

      if (!row.cnic || !String(row.cnic).trim()) {
        logError({
          migration: 'criminal_verification_forms',
          oldId: row.id,
          message: 'Missing CNIC — skipped form',
          stack: null,
        });
        continue;
      }

      const docs = docMap.get(Number(row.id));
      const formId = createId();
      const createdAt =
        row.verification_timestamp || row.registration_timestamp || now;
      const placeOfBirth = strOr(row.employment_city, 'Unknown');
      const address = strOr(row.address, 'Unknown');
      const { cityId, provinceId } = resolveCityProvince(row, lookups);
      const result = mapFormResult(
        row.cplc_verification_status,
        row.sindh_police_verification_status,
        row.islamabad_police_verification_status
      );
      const resultAt = result ? row.verification_timestamp || createdAt : null;
      const resultNotes = result
        ? `Migrated from legacy employment #${row.id}`
        : null;
      // Legacy URLs — convert via `npm run migrate:assets`
      const cnicFront =
        normalizeLegacyFileRef(docs?.cnic_front_picture_link) ||
        normalizeLegacyFileRef(row.worker_cnic_front);
      const cnicBack =
        normalizeLegacyFileRef(docs?.cnic_back_picture_link) ||
        normalizeLegacyFileRef(row.worker_cnic_back);
      const facePhoto =
        normalizeLegacyFileRef(docs?.picture_link) ||
        normalizeLegacyFileRef(row.worker_face_photo);
      const cnicNumber =
        decryptLegacy(String(row.cnic).trim()) || '0000000000000';

      let finalCityId = cityId;
      let finalProvinceId = provinceId;
      if (finalCityId == null || finalProvinceId == null) {
        formsCityMissing += 1;
        batchCityMissing += 1;
        finalCityId = lookups.fallbackCityId;
        finalProvinceId = lookups.fallbackProvinceId;
        logError({
          migration: 'criminal_verification_forms',
          oldId: row.id,
          message: `No city/province match for worker (city_id=${row.worker_city_id}, employment city="${row.employment_city}") — using fallback city ${finalCityId}`,
          stack: null,
        });
      }

      formRows.push({
        id: row.id,
        oldId,
        formId,
        values: [
          formId,
          taskId,
          strOr(row.full_name, 'Unknown'),
          strOr(row.father_name, 'Unknown'),
          row.date_of_birth || PLACEHOLDER_DOB,
          placeOfBirth,
          cnicNumber,
          PLACEHOLDER_CNIC_EXPIRY,
          cnicFront,
          cnicBack,
          facePhoto,
          address,
          address,
          finalCityId,
          finalProvinceId,
          result,
          resultNotes,
          resultAt,
          createdAt,
          createdAt,
        ],
      });

      const verdict = mapCplcVerdict(row.cplc_verification_status);
      if (verdict && !cplcMap[oldId]) {
        const cplcId = createId();
        cplcRows.push({
          id: row.id,
          oldId,
          cplcId,
          values: [
            cplcId,
            taskId,
            systemUserId,
            verdict,
            `Migrated from legacy CPLC status: ${row.cplc_verification_status}`,
            row.verification_timestamp || createdAt,
            createdAt,
            createdAt,
          ],
        });
      }
    }

    if (formRows.length > 0) {
      const { succeeded } = await bulkInsertWithFallback(
        newDb,
        'criminal_verification_forms',
        [
          'id',
          '"taskId"',
          '"fullName"',
          '"fatherName"',
          '"dateOfBirth"',
          '"placeOfBirth"',
          '"cnicNumber"',
          '"cnicExpiry"',
          '"cnicFrontKey"',
          '"cnicBackKey"',
          '"facePhotoKey"',
          '"currentAddress"',
          '"permanentAddress"',
          '"cityId"',
          '"provinceId"',
          'result',
          '"resultNotes"',
          '"resultAt"',
          '"createdAt"',
          '"updatedAt"',
        ],
        formRows,
        {
          migration: 'criminal_verification_forms',
          chunkSize: FORM_BULK_CHUNK,
          toValues: (item) => item.values,
          onSuccess: (chunk) => {
            for (const item of chunk) {
              formMap[item.oldId] = item.formId;
            }
          },
        }
      );
      batchFormsAdded = succeeded;
      formsInserted += succeeded;
    }

    if (cplcRows.length > 0) {
      const { succeeded } = await bulkInsertWithFallback(
        newDb,
        'cplc_verification_reviews',
        [
          'id',
          '"taskId"',
          '"reviewerId"',
          'verdict',
          'notes',
          '"reviewedAt"',
          '"createdAt"',
          '"updatedAt"',
        ],
        cplcRows,
        {
          migration: 'cplc_verification_reviews',
          chunkSize: FORM_BULK_CHUNK,
          toValues: (item) => item.values,
          onSuccess: (chunk) => {
            for (const item of chunk) {
              cplcMap[item.oldId] = item.cplcId;
            }
          },
        }
      );
      batchCplcAdded = succeeded;
      cplcInserted += succeeded;
    }

    reportProgress('Criminal Verification Forms', {
      added: formsInserted,
      processed,
      total: sourceTotal,
      skipped: formsSkipped,
      batch: batchNum,
    });

    if (
      batchFormsAdded > 0 ||
      batchCplcAdded > 0 ||
      batchSkipped > 0 ||
      batchCityMissing > 0
    ) {
      info(
        `  batch ${batchNum}: +${batchFormsAdded.toLocaleString()} forms` +
          `, +${batchCplcAdded.toLocaleString()} CPLC` +
          ` (skipped ${batchSkipped.toLocaleString()}, city missing ${batchCityMissing.toLocaleString()})`
      );
    }

    if (shouldSaveMaps(batchNum - 1)) {
      saveMap(FORM_MAP_NAME, formMap);
      saveMap(CPLC_MAP_NAME, cplcMap);
    }
  }

  saveMap(FORM_MAP_NAME, formMap);
  saveMap(CPLC_MAP_NAME, cplcMap);

  reportProgress('Criminal Verification Forms (done)', {
    added: formsInserted,
    processed,
    total: sourceTotal,
    skipped: formsSkipped,
  });

  reportDone('Criminal Verification Forms', Object.keys(formMap).length);
  if (formsSkipped > 0) success(`${formsSkipped} already mapped (skipped)`);
  if (formsCityMissing > 0) {
    success(`${formsCityMissing} forms used fallback city/province — no match found (see error log)`);
  }
  if (cplcInserted > 0) success(`${cplcInserted} CPLC reviews migrated`);

  return {
    formMap,
    cplcMap,
    inserted: formsInserted,
    skipped: formsSkipped,
    cityMissing: formsCityMissing,
    cplcInserted,
  };
}

module.exports = { migrateCriminalVerificationForms };
