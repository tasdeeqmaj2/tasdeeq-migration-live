const { getOldDb } = require('../db/oldDb');
const { getNewDb } = require('../db/newDb');
const { section, success, logError } = require('../utils/logger');
const { reportDone } = require('../utils/progress');
const { loadMap, saveMap } = require('../utils/maps');
const {
  forEachBatch,
  createId,
  shouldSaveMaps,
  DEFAULT_BATCH_SIZE,
} = require('../utils/batch');
const { bulkInsertWithFallback } = require('../utils/bulk');
const { resolveEmail, resolvePhone } = require('../utils/contactFields');

const USER_MAP_NAME = 'userMap.json';
const EMPLOYER_INDEX_NAME = 'employerUserIndex.json';

/**
 * Bulk resolve/create users + corporate_users for a batch of employer rows.
 */
async function insertCorporateUsersBulk(newDb, userMap, toInsert) {
  if (toInsert.length === 0) return 0;

  const now = new Date();
  const prepared = [];

  for (const row of toInsert) {
    const email = resolveEmail(row.email, {
      migration: 'corporate_users',
      oldId: row.id,
    });
    const phone = resolvePhone(row.phone_number, {
      migration: 'corporate_users',
      oldId: row.id,
    });

    prepared.push({
      row,
      oldId: String(row.id),
      email: email || null,
      phone: phone || null,
      name: (row.name && String(row.name).trim()) || `User ${row.id}`,
      isActive: row.is_active !== false,
      createdAt: row.created_at || now,
      companyId: row.companyId,
    });
  }

  const emails = [...new Set(prepared.map((p) => p.email).filter(Boolean))];
  const phones = [
    ...new Set(prepared.map((p) => p.phone).filter(Boolean)),
  ];

  const existingByEmail = new Map();
  const existingByPhone = new Map();

  if (emails.length) {
    const r = await newDb.query(
      `SELECT id, email, phone FROM users WHERE email = ANY($1::text[])`,
      [emails]
    );
    for (const row of r.rows) {
      existingByEmail.set(row.email, row.id);
      if (row.phone) existingByPhone.set(row.phone, row.id);
    }
  }
  if (phones.length) {
    const r = await newDb.query(
      `SELECT id, email, phone FROM users WHERE phone = ANY($1::text[])`,
      [phones]
    );
    for (const row of r.rows) {
      if (row.email) existingByEmail.set(row.email, row.id);
      if (row.phone) existingByPhone.set(row.phone, row.id);
    }
  }

  const usersToCreate = [];
  const resolved = [];

  for (const p of prepared) {
    let userId =
      (p.email ? existingByEmail.get(p.email) : null) ||
      (p.phone ? existingByPhone.get(p.phone) : null);

    if (!userId) {
      if (!p.email) {
        // Cannot insert into users without a valid unique email
        logError({
          migration: 'corporate_users',
          oldId: p.oldId,
          message:
            'Skipped corporate user — no valid email and no existing user match by phone',
          stack: null,
        });
        continue;
      }

      userId = createId();
      usersToCreate.push({
        id: p.oldId,
        userId,
        email: p.email,
        values: [
          userId,
          p.name,
          p.email,
          false,
          p.phone,
          'CORPORATE_USER',
          false,
          false,
          p.isActive,
          p.createdAt,
          p.createdAt,
        ],
      });
      existingByEmail.set(p.email, userId);
      if (p.phone) existingByPhone.set(p.phone, userId);
    }

    const corporateUserId = createId();
    resolved.push({
      id: p.oldId,
      oldId: p.oldId,
      userId,
      corporateUserId,
      companyId: p.companyId,
      values: [corporateUserId, userId, p.companyId, true],
    });
  }

  if (resolved.length === 0) return 0;

  if (usersToCreate.length) {
    await bulkInsertWithFallback(
      newDb,
      'users',
      [
        'id',
        'name',
        'email',
        '"emailVerified"',
        'phone',
        'role',
        'banned',
        '"isSuperAdmin"',
        '"isActive"',
        '"createdAt"',
        '"updatedAt"',
      ],
      usersToCreate,
      {
        migration: 'corporate_users_users',
        chunkSize: 1000,
        toValues: (item) => item.values,
        onConflict: 'ON CONFLICT (email) DO NOTHING',
      }
    );
  }

  // Ensure role even for existing users
  const userIds = [...new Set(resolved.map((r) => r.userId))];
  if (userIds.length) {
    await newDb.query(
      `UPDATE users SET role = 'CORPORATE_USER', "updatedAt" = NOW()
       WHERE id = ANY($1::text[])
         AND role IS DISTINCT FROM 'CORPORATE_USER'
         -- never demote app accounts (consumer app, CPLC portal, admins)
         AND (role IS NULL OR role NOT IN ('CONSUMER', 'CPLC_USER', 'admin', 'super_admin'))`,
      [userIds]
    );
  }

  const { succeeded } = await bulkInsertWithFallback(
    newDb,
    'corporate_users',
    ['id', '"userId"', '"companyId"', '"isAdmin"'],
    resolved,
    {
      migration: 'corporate_users',
      chunkSize: 1000,
      toValues: (item) => item.values,
      onConflict: 'ON CONFLICT ("userId") DO NOTHING',
      onSuccess: (chunk) => {
        for (const item of chunk) {
          userMap[item.oldId] = {
            userId: item.userId,
            corporateUserId: item.corporateUserId,
            companyId: item.companyId,
          };
        }
      },
    }
  );

  // ON CONFLICT may skip — still map from DB for any that exist
  for (const item of resolved) {
    if (!userMap[item.oldId]) {
      userMap[item.oldId] = {
        userId: item.userId,
        corporateUserId: item.corporateUserId,
        companyId: item.companyId,
      };
    }
  }

  return succeeded || resolved.length;
}

async function ensureCorporateRoles(newDb) {
  const result = await newDb.query(`
    UPDATE users u
    SET role = 'CORPORATE_USER',
        "updatedAt" = NOW()
    FROM corporate_users cu
    WHERE cu."userId" = u.id
      AND u.role IS DISTINCT FROM 'CORPORATE_USER'
      AND (u.role IS NULL OR u.role NOT IN ('CONSUMER', 'CPLC_USER', 'admin', 'super_admin'))
      -- consumers' personal companies use corporate_users too
      AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = cu."companyId" AND c."isConsumer")
  `);
  return result.rowCount || 0;
}

async function migrateCorporateUsers() {
  section('Migrating Corporate Users...');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const userMap = loadMap(USER_MAP_NAME);
  const employerUserIndex = loadMap(EMPLOYER_INDEX_NAME);

  let inserted = 0;
  let skipped = 0;

  async function handleBatch(rows, { batchIndex }) {
    const toInsert = [];
    for (const row of rows) {
      const oldId = String(row.id);
      if (userMap[oldId]) {
        skipped += 1;
        continue;
      }
      const companyId = employerUserIndex[oldId];
      if (!companyId) {
        logError({
          migration: 'corporate_users',
          oldId: row.id,
          message: `No company mapping for employer user ${row.id}`,
          stack: null,
        });
        continue;
      }
      toInsert.push({ ...row, companyId });
    }
    inserted += await insertCorporateUsersBulk(newDb, userMap, toInsert);
    if (shouldSaveMaps(batchIndex)) {
      saveMap(USER_MAP_NAME, userMap);
    }
  }

  await forEachBatch(
    async (lastId, limit) => {
      const result = await oldDb.query(
        `SELECT
           u.id,
           u.name,
           u.email,
           u.phone_number,
           u.cnic,
           u.is_active,
           u.created_at
         FROM "user" u
         INNER JOIN organization o ON o.user_id = u.id
         WHERE u.id > $1
         ORDER BY u.id
         LIMIT $2`,
        [lastId, limit]
      );
      return result.rows;
    },
    handleBatch,
    { size: DEFAULT_BATCH_SIZE, idField: 'id' }
  );

  await forEachBatch(
    async (lastId, limit) => {
      const result = await oldDb.query(
        `SELECT DISTINCT
           u.id,
           u.name,
           u.email,
           u.phone_number,
           u.cnic,
           u.is_active,
           u.created_at
         FROM "user" u
         INNER JOIN user_worker_employment e ON e.user_id = u.id AND e.is_active = true
         WHERE NOT EXISTS (
           SELECT 1 FROM organization o WHERE o.user_id = u.id
         )
           AND u.id > $1
         ORDER BY u.id
         LIMIT $2`,
        [lastId, limit]
      );
      return result.rows;
    },
    handleBatch,
    { size: DEFAULT_BATCH_SIZE, idField: 'id' }
  );

  const fixedRoles = await ensureCorporateRoles(newDb);
  if (fixedRoles > 0) {
    success(`Fixed role → CORPORATE_USER for ${fixedRoles} users`);
  }

  saveMap(USER_MAP_NAME, userMap);
  reportDone('Corporate Users', Object.keys(userMap).length);
  if (skipped > 0) success(`${skipped} already mapped (skipped)`);

  return { userMap, inserted, skipped, fixedRoles };
}

module.exports = { migrateCorporateUsers, ensureCorporateRoles };
