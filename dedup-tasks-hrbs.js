/**
 * Remove duplicate verification tasks for HRBS workers.
 * After the migration+dedup, workers that existed in both the original company
 * and the orphan now have 2 tasks each. Keep the more progressed one, delete the other.
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
if (!NEW_DB_URL) { console.error('Set NEW_DATABASE_URL in .env'); process.exit(1); }
const SSL = { rejectUnauthorized: false };

const DRY_RUN = process.env.DRY_RUN !== 'false';
const TARGET_ID = 'cmwnhyihg639a0e91da02f2c7';

// Status priority — higher = more progressed
const STATUS_RANK = {
  DRAFT: 0,
  FORM_SENT: 1,
  FORM_SUBMITTED: 2,
  APPROVED: 3,
  IN_CART: 4,
  INVOICED: 5,
  PENDING: 6,
  ASSIGNED: 7,
  COMPLETED: 8,
};

async function run() {
  const db = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  await db.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);

  // Find workers with multiple tasks
  const { rows: dupes } = await db.query(`
    SELECT vt."workerId", COUNT(*)::int AS cnt,
           ARRAY_AGG(vt.id) AS task_ids,
           ARRAY_AGG(vt.status) AS statuses,
           w.name, w.cnic
    FROM verification_tasks vt
    JOIN workers w ON w.id = vt."workerId"
    WHERE vt."companyId" = $1
    GROUP BY vt."workerId", w.name, w.cnic
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `, [TARGET_ID]);

  console.log(`Workers with multiple tasks: ${dupes.length}\n`);

  if (dupes.length === 0) {
    console.log('No duplicate tasks found.');
    await db.end();
    return;
  }

  let totalDeleted = 0;
  let formsDeleted = 0;
  let activitiesDeleted = 0;

  // Show first 5
  for (const d of dupes.slice(0, 5)) {
    console.log(`${d.name} (${d.cnic}): ${d.cnt} tasks — ${d.statuses.join(', ')}`);
  }
  if (dupes.length > 5) console.log(`  ... and ${dupes.length - 5} more\n`);

  if (!DRY_RUN) await db.query('BEGIN');

  try {
    for (const d of dupes) {
      // Get full task details
      const { rows: tasks } = await db.query(`
        SELECT vt.id, vt.status, vt."createdAt",
               (SELECT COUNT(*)::int FROM criminal_verification_forms cf WHERE cf."taskId" = vt.id) AS has_form,
               (SELECT id FROM cplc_verification_reviews cvr WHERE cvr."taskId" = vt.id) AS has_cplc
        FROM verification_tasks vt
        WHERE vt.id = ANY($1::text[])
        ORDER BY vt."createdAt" ASC
      `, [d.task_ids]);

      // Sort: keep the most progressed task
      tasks.sort((a, b) => (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0));

      const keep = tasks[0];
      const toDelete = tasks.slice(1);

      for (const td of toDelete) {
        if (!DRY_RUN) {
          // Delete form if exists
          const f = await db.query(`DELETE FROM criminal_verification_forms WHERE "taskId" = $1`, [td.id]);
          formsDeleted += f.rowCount;

          // Delete worker_activities referencing this task
          const a = await db.query(`DELETE FROM worker_activities WHERE "taskId" = $1`, [td.id]);
          activitiesDeleted += a.rowCount;

          // Delete invoice_items referencing this task
          await db.query(`DELETE FROM invoice_items WHERE "taskId" = $1`, [td.id]);

          // Delete verification_form_drafts
          await db.query(`DELETE FROM verification_form_drafts WHERE "taskId" = $1`, [td.id]);

          // Delete the task
          await db.query(`DELETE FROM verification_tasks WHERE id = $1`, [td.id]);
        }
        totalDeleted++;
      }
    }

    if (!DRY_RUN) {
      await db.query('COMMIT');
      console.log('\n✓ Committed.');
    }
  } catch (err) {
    if (!DRY_RUN) await db.query('ROLLBACK');
    console.error(`\n✗ ROLLBACK: ${err.message}`);
    await db.end();
    return;
  }

  console.log(`\nSummary:`);
  console.log(`  Duplicate tasks deleted: ${totalDeleted}`);
  if (!DRY_RUN) {
    console.log(`  Forms deleted: ${formsDeleted}`);
    console.log(`  Activities deleted: ${activitiesDeleted}`);
    const { rows: [{ cnt }] } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM verification_tasks WHERE "companyId" = $1`, [TARGET_ID]
    );
    console.log(`  Total tasks now: ${cnt}`);
  }

  await db.end();
}
run().catch(e => { console.error(e); process.exit(1); });
