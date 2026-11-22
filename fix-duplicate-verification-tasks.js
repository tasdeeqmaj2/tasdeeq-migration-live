/**
 * Fix duplicate verification tasks — same CNIC verified multiple times
 * for the same company (created during migration with duplicate worker records).
 *
 * Uses pg client (single connection) for performance on remote DBs.
 *
 * Usage:
 *   node fix-duplicate-verification-tasks.js --dry-run          # preview (local)
 *   node fix-duplicate-verification-tasks.js                    # apply (local)
 *   node fix-duplicate-verification-tasks.js --dry-run --prod   # preview (production)
 *   node fix-duplicate-verification-tasks.js --prod             # apply (production)
 */

require('dotenv').config();
const { Client } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const PROD = process.argv.includes('--prod');

const DB_URL = PROD
  ? (process.env.DATABASE_URL || process.env.NEW_DATABASE_URL)
  : (process.env.NEW_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5432/tasdeeq');

if (!DB_URL) { console.error('No database URL found in .env'); process.exit(1); }

const STATUS_PRIORITY = {
  'COMPLETED': 7, 'ASSIGNED': 6, 'PENDING': 5, 'APPROVED': 4,
  'FORM_SUBMITTED': 3, 'FORM_SENT': 2, 'DRAFT': 1,
};

async function main() {
  const db = new Client({ connectionString: DB_URL, ssl: PROD ? { rejectUnauthorized: false } : false });
  await db.connect();
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${PROD ? '[PRODUCTION] ' : '[LOCAL] '}Connected.\n`);

  // Current queue counts
  const { rows: queueRows } = await db.query(`
    SELECT status, COUNT(*)::int AS cnt FROM verification_tasks
    WHERE type = 'CRIMINAL' AND status IN ('PENDING', 'ASSIGNED', 'COMPLETED')
    GROUP BY status ORDER BY status
  `);
  console.log('Current CPLC queue:');
  queueRows.forEach(r => console.log(`  ${r.status}: ${r.cnt}`));

  // Find all tasks grouped by CNIC + company, with their details
  console.log('\nFinding duplicate CRIMINAL tasks (same CNIC + company)...\n');

  const { rows: allTasks } = await db.query(`
    SELECT vt.id, vt.status, vt."createdAt", vt."workerId",
           w.cnic, w.name AS worker_name,
           vt."companyId", c.name AS company_name,
           (cf.id IS NOT NULL) AS has_form,
           (cr.id IS NOT NULL) AS has_cplc_review,
           (ii.id IS NOT NULL) AS has_invoice_item
    FROM verification_tasks vt
    JOIN workers w ON w.id = vt."workerId"
    JOIN companies c ON c.id = vt."companyId"
    LEFT JOIN criminal_verification_forms cf ON cf."taskId" = vt.id
    LEFT JOIN cplc_verification_reviews cr ON cr."taskId" = vt.id
    LEFT JOIN (SELECT DISTINCT "taskId" AS id FROM invoice_items) ii ON ii.id = vt.id
    WHERE vt.type = 'CRIMINAL'
      AND w.cnic IS NOT NULL AND w.cnic != ''
    ORDER BY w.cnic, vt."companyId", vt."createdAt" DESC
  `);

  // Group by cnic + companyId
  const groups = {};
  for (const t of allTasks) {
    const key = `${t.cnic}::${t.companyId}`;
    if (!groups[key]) groups[key] = { cnic: t.cnic, companyId: t.companyId, workerName: t.worker_name, companyName: t.company_name, tasks: [] };
    groups[key].tasks.push({
      id: t.id,
      status: t.status,
      createdAt: t.createdAt,
      workerId: t.workerId,
      hasForm: t.has_form,
      hasCplcReview: t.has_cplc_review,
      hasInvoiceItem: t.has_invoice_item,
      priority: STATUS_PRIORITY[t.status] || 0,
    });
  }

  const dupeGroups = Object.values(groups).filter(g => g.tasks.length > 1);

  if (dupeGroups.length === 0) {
    console.log('No duplicate verification tasks found.');
    await db.end();
    return;
  }

  const totalDupes = dupeGroups.reduce((s, g) => s + g.tasks.length - 1, 0);
  console.log(`Found ${dupeGroups.length} CNIC-company pairs with duplicates.`);
  console.log(`Total duplicate tasks to remove: ${totalDupes}\n`);

  const allTaskIdsToDelete = [];
  const allOrphanWorkerIds = [];
  let totalSkippedInvoice = 0;
  let shown = 0;

  for (const g of dupeGroups) {
    // Sort: highest status first, then has CPLC review, then has form, then most recent
    g.tasks.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.hasCplcReview !== a.hasCplcReview) return b.hasCplcReview ? 1 : -1;
      if (b.hasForm !== a.hasForm) return b.hasForm ? 1 : -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    const keep = g.tasks[0];
    const toDelete = g.tasks.slice(1);

    if (toDelete.length === 0) continue;

    if (shown < 20) {
      const invoiced = toDelete.filter(t => t.hasInvoiceItem).length;
      console.log(`${DRY_RUN ? '[DRY] ' : ''}CNIC ${g.cnic} @ ${g.companyName}: keep ${keep.id} (${keep.status}), delete ${toDelete.length}${invoiced ? ` (${invoiced} with invoice items)` : ''}`);
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
  console.log(`Duplicate groups: ${dupeGroups.length}`);
  console.log(`Tasks to delete: ${allTaskIdsToDelete.length}`);
  console.log(`Potential orphan workers: ${[...new Set(allOrphanWorkerIds)].length}`);

  if (!DRY_RUN && allTaskIdsToDelete.length > 0) {
    console.log('\nDeleting in batches...');

    // Process in chunks of 200
    for (let i = 0; i < allTaskIdsToDelete.length; i += 200) {
      const chunk = allTaskIdsToDelete.slice(i, i + 200);
      const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');

      await db.query(`DELETE FROM invoice_items WHERE "taskId" IN (${placeholders})`, chunk);
      await db.query(`DELETE FROM criminal_verification_forms WHERE "taskId" IN (${placeholders})`, chunk);
      await db.query(`DELETE FROM cplc_verification_reviews WHERE "taskId" IN (${placeholders})`, chunk);
      await db.query(`DELETE FROM verification_form_drafts WHERE "taskId" IN (${placeholders})`, chunk);
      await db.query(`DELETE FROM worker_activities WHERE "taskId" IN (${placeholders})`, chunk);
      await db.query(`DELETE FROM verification_tasks WHERE id IN (${placeholders})`, chunk);

      console.log(`  Deleted batch ${Math.floor(i / 200) + 1} (${chunk.length} tasks)`);
    }

    // Delete orphan workers
    if (allOrphanWorkerIds.length > 0) {
      const uniqueWorkers = [...new Set(allOrphanWorkerIds)];
      for (let i = 0; i < uniqueWorkers.length; i += 200) {
        const chunk = uniqueWorkers.slice(i, i + 200);
        const placeholders = chunk.map((_, idx) => `$${idx + 1}`).join(',');
        const { rowCount } = await db.query(`
          DELETE FROM workers WHERE id IN (${placeholders})
          AND NOT EXISTS (SELECT 1 FROM verification_tasks vt WHERE vt."workerId" = workers.id)
        `, chunk);
        console.log(`  Removed ${rowCount} orphan workers (batch ${Math.floor(i / 200) + 1})`);
      }
    }

    // New queue counts
    const { rows: newQueueRows } = await db.query(`
      SELECT status, COUNT(*)::int AS cnt FROM verification_tasks
      WHERE type = 'CRIMINAL' AND status IN ('PENDING', 'ASSIGNED', 'COMPLETED')
      GROUP BY status ORDER BY status
    `);
    console.log('\nNew CPLC queue:');
    newQueueRows.forEach(r => console.log(`  ${r.status}: ${r.cnt}`));
  }

  await db.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
