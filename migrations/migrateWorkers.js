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
const { decryptLegacy } = require('../utils/decrypt');
const { resolvePhone } = require('../utils/contactFields');

const WORKER_MAP_NAME = 'workerMap.json';
const EMPLOYER_INDEX_NAME = 'employerUserIndex.json';

function decryptField(value) {
  if (value == null) return value;
  const s = String(value).trim();
  return s ? decryptLegacy(s) : s;
}

async function migrateWorkers(systemUserId) {
  section('Migrating Workers...');

  if (!systemUserId) {
    throw new Error('systemUserId is required for worker migration');
  }

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const workerMap = loadMap(WORKER_MAP_NAME);
  const employerUserIndex = loadMap(EMPLOYER_INDEX_NAME);

  let inserted = 0;
  let skipped = 0;

  await forEachBatch(
    async (lastId, limit) => {
      const result = await oldDb.query(
        `SELECT
           e.id,
           e.user_id,
           e.full_name,
           e.registration_timestamp,
           w.cnic,
           w.phone_number,
           w.created_at AS worker_created_at
         FROM user_worker_employment e
         INNER JOIN worker w ON w.id = e.worker_id
         WHERE e.id > $1
         ORDER BY e.id
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
        if (workerMap[oldId]) {
          skipped += 1;
          continue;
        }

        const cnic = decryptField(row.cnic);
        if (!cnic) {
          logError({
            migration: 'workers',
            oldId: row.id,
            message: 'Missing CNIC — skipped',
            stack: null,
          });
          continue;
        }

        const companyId = employerUserIndex[String(row.user_id)];
        if (!companyId) {
          logError({
            migration: 'workers',
            oldId: row.id,
            message: `No company mapping for employer user_id ${row.user_id}`,
            stack: null,
          });
          continue;
        }

        const newId = createId();
        const name =
          (row.full_name && String(row.full_name).trim()) || 'Unknown';
        // workers.email is NOT NULL but legacy worker rows have no email column —
        // never invent @migrated.invalid; store empty string.
        const email = '';
        // workers.mobile is NOT NULL — resolve/decrypt phone; keep original if invalid
        // rather than inventing 00000000000.
        const mobile = resolvePhone(row.phone_number, {
          migration: 'workers',
          oldId: row.id,
          required: true,
        });
        const createdAt =
          row.registration_timestamp || row.worker_created_at || now;

        toInsert.push({
          id: row.id,
          oldId,
          newId,
          values: [
            newId,
            companyId,
            systemUserId,
            name,
            email,
            mobile,
            cnic,
            createdAt,
            createdAt,
          ],
        });
      }

      if (toInsert.length === 0) return;

      const { succeeded } = await bulkInsertWithFallback(
        newDb,
        'workers',
        [
          'id',
          '"companyId"',
          '"createdById"',
          'name',
          'email',
          'mobile',
          'cnic',
          '"createdAt"',
          '"updatedAt"',
        ],
        toInsert,
        {
          migration: 'workers',
          chunkSize: 1000,
          toValues: (item) => item.values,
          onSuccess: (chunk) => {
            for (const item of chunk) {
              workerMap[item.oldId] = item.newId;
            }
          },
        }
      );

      inserted += succeeded;
      if (shouldSaveMaps(batchIndex)) {
        saveMap(WORKER_MAP_NAME, workerMap);
      }
    },
    { size: DEFAULT_BATCH_SIZE }
  );

  saveMap(WORKER_MAP_NAME, workerMap);
  reportDone('Workers', Object.keys(workerMap).length);
  if (skipped > 0) success(`${skipped} already mapped (skipped)`);

  return { workerMap, inserted, skipped };
}

module.exports = { migrateWorkers };
