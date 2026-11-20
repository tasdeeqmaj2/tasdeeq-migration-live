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

const TASK_MAP_NAME = 'verificationTaskMap.json';
const WORKER_MAP_NAME = 'workerMap.json';
const EMPLOYER_INDEX_NAME = 'employerUserIndex.json';

function mapStatus(...statuses) {
  const combined = statuses
    .filter((s) => s != null && String(s).trim())
    .map((s) => String(s).toLowerCase())
    .join(' ');

  // All statuses NULL = pending verification (never started)
  if (!combined) return 'PENDING';

  if (/verified|approved|completed|success|clear|passed/.test(combined)) {
    return 'COMPLETED';
  }
  if (
    /pending|in_progress|in-progress|processing|submitted|in progress/.test(
      combined
    )
  ) {
    return 'PENDING';
  }
  if (/rejected|failed|denied|cancelled|canceled/.test(combined)) {
    return 'CANCELLED';
  }
  return 'DRAFT';
}

async function migrateVerificationTasks(systemUserId) {
  section('Migrating Verification Tasks...');

  if (!systemUserId) {
    throw new Error('systemUserId is required for verification task migration');
  }

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const taskMap = loadMap(TASK_MAP_NAME);
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
           e.cplc_verification_status,
           e.sindh_police_verification_status,
           e.islamabad_police_verification_status,
           e.verification_timestamp,
           e.registration_timestamp
         FROM user_worker_employment e
         WHERE e.is_active = true
           AND e.id > $1
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
        if (taskMap[oldId]) {
          skipped += 1;
          continue;
        }

        const workerId = workerMap[oldId];
        if (!workerId) continue;

        const companyId = employerUserIndex[String(row.user_id)];
        if (!companyId) {
          logError({
            migration: 'verification_tasks',
            oldId: row.id,
            message: `No company mapping for employer user_id ${row.user_id}`,
            stack: null,
          });
          continue;
        }

        const status = mapStatus(
          row.cplc_verification_status,
          row.sindh_police_verification_status,
          row.islamabad_police_verification_status
        );
        if (!status) continue;

        const newId = createId();
        const createdAt =
          row.verification_timestamp || row.registration_timestamp || now;

        toInsert.push({
          id: row.id,
          oldId,
          newId,
          values: [
            newId,
            workerId,
            companyId,
            systemUserId,
            'CRIMINAL',
            status,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            createdAt,
            createdAt,
          ],
        });
      }

      if (toInsert.length === 0) return;

      const { succeeded } = await bulkInsertWithFallback(
        newDb,
        'verification_tasks',
        [
          'id',
          '"workerId"',
          '"companyId"',
          '"createdById"',
          'type',
          'status',
          '"filledBy"',
          '"formLinkToken"',
          '"formLinkOtp"',
          '"formLinkOtpExpiry"',
          '"approvedById"',
          '"approvedAt"',
          '"assignedToId"',
          '"assignedAt"',
          '"invoiceId"',
          '"createdAt"',
          '"updatedAt"',
        ],
        toInsert,
        {
          migration: 'verification_tasks',
          chunkSize: 1000,
          toValues: (item) => item.values,
          onSuccess: (chunk) => {
            for (const item of chunk) {
              taskMap[item.oldId] = item.newId;
            }
          },
        }
      );

      inserted += succeeded;
      if (shouldSaveMaps(batchIndex)) {
        saveMap(TASK_MAP_NAME, taskMap);
      }
    },
    { size: DEFAULT_BATCH_SIZE }
  );

  saveMap(TASK_MAP_NAME, taskMap);
  reportDone('Verification Tasks', Object.keys(taskMap).length);
  if (skipped > 0) success(`${skipped} already mapped (skipped)`);

  return { taskMap, inserted, skipped };
}

module.exports = { migrateVerificationTasks };
