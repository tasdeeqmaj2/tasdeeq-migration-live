/**
 * Fix verification tasks that were migrated with wrong status.
 * Employments where all 3 status columns are NULL should be PENDING,
 * but the old migration mapped them as DRAFT/COMPLETED.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { section, info, success } = require('./utils/logger');

const TASK_MAP_NAME = 'verificationTaskMap.json';

async function main() {
  section('Fix pending verification task statuses');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const taskMap = loadMap(TASK_MAP_NAME);

  // Find employments in old DB where cplc_verification_status is 'pending'
  // These were wrongly mapped as COMPLETED because the other columns have 'approved'
  const { rows } = await oldDb.query(`
    SELECT e.id
    FROM user_worker_employment e
    WHERE e.is_active = true
      AND e.cplc_verification_status = 'pending'
  `);

  info(`Found ${rows.length} employments with all-NULL statuses in old DB`);

  let updated = 0;
  let skipped = 0;
  let notMapped = 0;

  for (const row of rows) {
    const oldId = String(row.id);
    const newTaskId = taskMap[oldId];

    if (!newTaskId) {
      notMapped++;
      continue;
    }

    // Check current status in new DB
    const { rows: taskRows } = await newDb.query(
      `SELECT status FROM verification_tasks WHERE id = $1`,
      [newTaskId]
    );

    if (taskRows.length === 0) {
      notMapped++;
      continue;
    }

    if (taskRows[0].status === 'PENDING') {
      skipped++;
      continue;
    }

    // Fix: set to PENDING
    await newDb.query(
      `UPDATE verification_tasks SET status = 'PENDING' WHERE id = $1`,
      [newTaskId]
    );
    updated++;
  }

  success(`Updated ${updated} tasks to PENDING`);
  info(`Already PENDING: ${skipped}, Not mapped: ${notMapped}`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
