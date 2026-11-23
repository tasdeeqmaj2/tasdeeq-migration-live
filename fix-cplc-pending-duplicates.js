/**
 * Fix CPLC PENDING duplicates — same CNIC appearing multiple times in PENDING
 * across different companies (migration created duplicate companies for same user).
 *
 * Keeps the most recent PENDING task per CNIC, deletes the rest.
 *
 * Usage:
 *   node fix-cplc-pending-duplicates.js --dry-run --prod
 *   node fix-cplc-pending-duplicates.js --prod
 */

const { Client } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const PROD = process.argv.includes('--prod');

// For prod, pass DATABASE_URL as env var: DATABASE_URL=... node script.js --prod
const DB_URL = PROD
  ? process.env.DATABASE_URL
  : 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';

async function main() {
  const db = new Client({ connectionString: DB_URL, ssl: PROD ? { rejectUnauthorized: false } : false });
  await db.connect();
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${PROD ? '[PRODUCTION] ' : '[LOCAL] '}Connected.\n`);

  // Current PENDING count
  const { rows: [{ cnt: beforeCount }] } = await db.query(`
    SELECT COUNT(*)::int AS cnt FROM verification_tasks
    WHERE type = 'CRIMINAL' AND status = 'PENDING'
  `);
  console.log(`Current PENDING tasks: ${beforeCount}\n`);

  // Find all PENDING tasks grouped by CNIC with duplicates
  const { rows: allPending } = await db.query(`
    SELECT vt.id, vt."createdAt", vt."workerId", vt."companyId",
           w.cnic, w.name AS worker_name, c.name AS company_name
    FROM verification_tasks vt
    JOIN workers w ON w.id = vt."workerId"
    JOIN companies c ON c.id = vt."companyId"
    WHERE vt.type = 'CRIMINAL' AND vt.status = 'PENDING'
      AND w.cnic IS NOT NULL AND w.cnic != ''
    ORDER BY w.cnic, vt."createdAt" DESC
  `);

  // Group by CNIC
  const groups = {};
  for (const t of allPending) {
    if (!groups[t.cnic]) groups[t.cnic] = [];
    groups[t.cnic].push(t);
  }

  const dupeGroups = Object.entries(groups).filter(([, tasks]) => tasks.length > 1);

  if (dupeGroups.length === 0) {
    console.log('No PENDING duplicates found.');
    await db.end();
    return;
  }

  const totalDupes = dupeGroups.reduce((s, [, tasks]) => s + tasks.length - 1, 0);
  console.log(`Found ${dupeGroups.length} CNICs with duplicate PENDING tasks.`);
  console.log(`Tasks to delete: ${totalDupes}\n`);

  const allTaskIdsToDelete = [];
  const allOrphanWorkerIds = [];
  let shown = 0;

  for (const [cnic, tasks] of dupeGroups) {
    // Keep the most recent task
    const keep = tasks[0]; // already sorted by createdAt DESC
    const toDelete = tasks.slice(1);

    if (shown < 20) {
      console.log(`${DRY_RUN ? '[DRY] ' : ''}CNIC ${cnic} (${keep.worker_name}): keep @ ${keep.company_name}, delete ${toDelete.length} from: ${toDelete.map(t => t.company_name).join(', ')}`);
      shown++;
    }

    for (const t of toDelete) {
      allTaskIdsToDelete.push(t.id);
      if (t.workerId !== keep.workerId) {
        allOrphanWorkerIds.push(t.workerId);
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Duplicate CNIC groups: ${dupeGroups.length}`);
  console.log(`PENDING tasks to delete: ${allTaskIdsToDelete.length}`);
  console.log(`Expected PENDING after: ${beforeCount - allTaskIdsToDelete.length}`);

  if (!DRY_RUN && allTaskIdsToDelete.length > 0) {
    console.log('\nDeleting...');

    for (let i = 0; i < allTaskIdsToDelete.length; i += 200) {
      const chunk = allTaskIdsToDelete.slice(i, i + 200);
      const ph = chunk.map((_, idx) => `$${idx + 1}`).join(',');

      await db.query(`DELETE FROM invoice_items WHERE "taskId" IN (${ph})`, chunk);
      await db.query(`DELETE FROM criminal_verification_forms WHERE "taskId" IN (${ph})`, chunk);
      await db.query(`DELETE FROM cplc_verification_reviews WHERE "taskId" IN (${ph})`, chunk);
      await db.query(`DELETE FROM verification_form_drafts WHERE "taskId" IN (${ph})`, chunk);
      await db.query(`DELETE FROM worker_activities WHERE "taskId" IN (${ph})`, chunk);
      await db.query(`DELETE FROM verification_tasks WHERE id IN (${ph})`, chunk);

      console.log(`  Deleted batch ${Math.floor(i / 200) + 1} (${chunk.length} tasks)`);
    }

    // Delete orphan workers
    const uniqueWorkers = [...new Set(allOrphanWorkerIds)];
    if (uniqueWorkers.length > 0) {
      for (let i = 0; i < uniqueWorkers.length; i += 200) {
        const chunk = uniqueWorkers.slice(i, i + 200);
        const ph = chunk.map((_, idx) => `$${idx + 1}`).join(',');
        const { rowCount } = await db.query(`
          DELETE FROM workers WHERE id IN (${ph})
          AND NOT EXISTS (SELECT 1 FROM verification_tasks vt WHERE vt."workerId" = workers.id)
        `, chunk);
        console.log(`  Removed ${rowCount} orphan workers`);
      }
    }

    // New count
    const { rows: [{ cnt: afterCount }] } = await db.query(`
      SELECT COUNT(*)::int AS cnt FROM verification_tasks
      WHERE type = 'CRIMINAL' AND status = 'PENDING'
    `);
    console.log(`\nPENDING tasks after: ${afterCount}`);
  }

  await db.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
