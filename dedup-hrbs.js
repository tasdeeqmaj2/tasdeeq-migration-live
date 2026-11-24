/**
 * Find and fix duplicate workers (by CNIC) in HR Business Solutions.
 * When duplicates exist, keep the one with more tasks/data and move the other's tasks over.
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

async function run() {
  const db = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  await db.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);

  // Find duplicate CNICs within the company
  const { rows: dupes } = await db.query(`
    SELECT cnic, COUNT(*)::int AS cnt, ARRAY_AGG(id) AS worker_ids, ARRAY_AGG(name) AS names
    FROM workers
    WHERE "companyId" = $1 AND cnic IS NOT NULL
    GROUP BY cnic
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `, [TARGET_ID]);

  console.log(`Duplicate CNIC groups: ${dupes.length}\n`);

  if (dupes.length === 0) {
    console.log('No duplicates found.');
    await db.end();
    return;
  }

  let totalMerged = 0;
  let totalTasksMoved = 0;
  let totalInvoiceItemsMoved = 0;
  let totalDeleted = 0;

  if (!DRY_RUN) await db.query('BEGIN');

  try {
    for (const dup of dupes) {
      // For each worker, count tasks
      const { rows: workers } = await db.query(`
        SELECT w.id, w.name, w.cnic, w.email, w.mobile, w."createdAt",
               (SELECT COUNT(*)::int FROM verification_tasks vt WHERE vt."workerId" = w.id) AS task_count,
               (SELECT COUNT(*)::int FROM verification_tasks vt WHERE vt."workerId" = w.id AND vt.status != 'DRAFT') AS active_tasks,
               (SELECT COUNT(*)::int FROM criminal_verification_forms cf
                JOIN verification_tasks vt ON vt.id = cf."taskId"
                WHERE vt."workerId" = w.id) AS form_count
        FROM workers w
        WHERE w.id = ANY($1::text[])
        ORDER BY active_tasks DESC, task_count DESC, w."createdAt" ASC
      `, [dup.worker_ids]);

      // Keep the first one (most tasks/active tasks, oldest)
      const keep = workers[0];
      const remove = workers.slice(1);

      if (DRY_RUN && dupes.indexOf(dup) < 5) {
        console.log(`CNIC ${dup.cnic}:`);
        console.log(`  KEEP: ${keep.id} "${keep.name}" tasks=${keep.task_count} active=${keep.active_tasks} forms=${keep.form_count}`);
        for (const r of remove) {
          console.log(`  REMOVE: ${r.id} "${r.name}" tasks=${r.task_count} active=${r.active_tasks} forms=${r.form_count}`);
        }
      }

      for (const r of remove) {
        // Move tasks from removed worker to kept worker
        if (!DRY_RUN) {
          const moved = await db.query(
            `UPDATE verification_tasks SET "workerId" = $1 WHERE "workerId" = $2`,
            [keep.id, r.id]
          );
          totalTasksMoved += moved.rowCount;

          // Move worker_activities
          await db.query(
            `UPDATE worker_activities SET "workerId" = $1 WHERE "workerId" = $2`,
            [keep.id, r.id]
          );

          // Delete the duplicate worker (no more references)
          await db.query(`DELETE FROM workers WHERE id = $1`, [r.id]);
        } else {
          totalTasksMoved += r.task_count;
        }
        totalDeleted++;
      }
      totalMerged++;
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
  console.log(`  Duplicate groups merged: ${totalMerged}`);
  console.log(`  Tasks reassigned: ${totalTasksMoved}`);
  console.log(`  Workers deleted: ${totalDeleted}`);

  if (!DRY_RUN) {
    const { rows: [{ cnt }] } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM workers WHERE "companyId" = $1`, [TARGET_ID]
    );
    console.log(`  Total workers now: ${cnt}`);
  }

  await db.end();
}
run().catch(e => { console.error(e); process.exit(1); });
