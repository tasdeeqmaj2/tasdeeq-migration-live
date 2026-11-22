/**
 * Fix duplicate verification tasks — same worker verified multiple times
 * for the same company (created during migration).
 *
 * Strategy: For each (workerId, companyId, type='CRIMINAL') group with >1 task,
 * keep the most recent / most progressed task and delete the others.
 * Priority: COMPLETED > ASSIGNED > PENDING > APPROVED > FORM_SUBMITTED > FORM_SENT > DRAFT
 *
 * Usage:
 *   node fix-duplicate-verification-tasks.js --dry-run          # preview (local docker)
 *   node fix-duplicate-verification-tasks.js                    # apply (local docker)
 *   node fix-duplicate-verification-tasks.js --dry-run --prod   # preview (production)
 *   node fix-duplicate-verification-tasks.js --prod             # apply (production)
 */

const { execSync } = require('child_process');

const DRY_RUN = process.argv.includes('--dry-run');
const PROD = process.argv.includes('--prod');

function psql(sql) {
  const escaped = sql.replace(/\n/g, ' ');
  if (PROD) {
    require('dotenv').config();
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) { console.error('DATABASE_URL not set'); process.exit(1); }
    return execSync(
      `psql "${dbUrl}" -t -A -F "||" -c ${JSON.stringify(escaped)}`,
      { encoding: 'utf8' }
    ).trim();
  }
  return execSync(
    `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -t -A -F "||" -c "${escaped.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();
}

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${PROD ? '[PRODUCTION] ' : '[LOCAL] '}`);
console.log('Finding duplicate CRIMINAL verification tasks (same worker + company)...\n');

// Find groups with duplicates
const dupes = psql(`
  SELECT vt."workerId", vt."companyId", COUNT(*) AS cnt,
         w.name AS worker_name, c.name AS company_name
  FROM verification_tasks vt
  JOIN workers w ON w.id = vt."workerId"
  JOIN companies c ON c.id = vt."companyId"
  WHERE vt.type = 'CRIMINAL'
  GROUP BY vt."workerId", vt."companyId", w.name, c.name
  HAVING COUNT(*) > 1
  ORDER BY COUNT(*) DESC
`);

if (!dupes) {
  console.log('No duplicate verification tasks found.');
  process.exit(0);
}

const groups = dupes.split('\n').filter(Boolean).map(r => {
  const [workerId, companyId, cnt, workerName, companyName] = r.split('||');
  return { workerId, companyId, count: parseInt(cnt), workerName, companyName };
});

console.log(`Found ${groups.length} worker-company pairs with duplicate tasks.\n`);

const STATUS_PRIORITY = {
  'COMPLETED': 7,
  'ASSIGNED': 6,
  'PENDING': 5,
  'APPROVED': 4,
  'FORM_SUBMITTED': 3,
  'FORM_SENT': 2,
  'DRAFT': 1,
};

let totalDeleted = 0;
let totalKept = 0;

for (const g of groups) {
  // Get all tasks for this worker+company
  const tasks = psql(`
    SELECT vt.id, vt.status, vt."createdAt",
           CASE WHEN cf.id IS NOT NULL THEN 1 ELSE 0 END AS has_form,
           CASE WHEN cr.id IS NOT NULL THEN 1 ELSE 0 END AS has_cplc_review,
           CASE WHEN ii.id IS NOT NULL THEN 1 ELSE 0 END AS has_invoice_item
    FROM verification_tasks vt
    LEFT JOIN criminal_verification_forms cf ON cf."taskId" = vt.id
    LEFT JOIN cplc_verification_reviews cr ON cr."taskId" = vt.id
    LEFT JOIN invoice_items ii ON ii."taskId" = vt.id
    WHERE vt."workerId" = '${g.workerId}'
      AND vt."companyId" = '${g.companyId}'
      AND vt.type = 'CRIMINAL'
    ORDER BY vt."createdAt" DESC
  `);

  const taskList = tasks.split('\n').filter(Boolean).map(r => {
    const [id, status, createdAt, hasForm, hasCplcReview, hasInvoiceItem] = r.split('||');
    return {
      id, status, createdAt,
      hasForm: hasForm === '1',
      hasCplcReview: hasCplcReview === '1',
      hasInvoiceItem: hasInvoiceItem === '1',
      priority: STATUS_PRIORITY[status] || 0,
    };
  });

  // Sort: highest status priority first, then most recent
  taskList.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const keep = taskList[0];
  const toDelete = taskList.slice(1);

  // Don't delete tasks that have invoice items (they affect billing)
  const safeToDelete = toDelete.filter(t => !t.hasInvoiceItem);
  const unsafe = toDelete.filter(t => t.hasInvoiceItem);

  if (unsafe.length > 0) {
    console.log(`  ⚠ ${g.workerName} @ ${g.companyName}: ${unsafe.length} duplicate(s) have invoice items — SKIPPING those`);
  }

  if (safeToDelete.length === 0) continue;

  console.log(`${DRY_RUN ? '[DRY] ' : ''}${g.workerName} @ ${g.companyName}: keep ${keep.id} (${keep.status}), delete ${safeToDelete.length} duplicate(s)`);

  if (!DRY_RUN) {
    const idsToDelete = safeToDelete.map(t => `'${t.id}'`).join(',');

    // Delete related records first
    psql(`DELETE FROM criminal_verification_forms WHERE "taskId" IN (${idsToDelete})`);
    psql(`DELETE FROM cplc_verification_reviews WHERE "taskId" IN (${idsToDelete})`);
    psql(`DELETE FROM verification_form_drafts WHERE "taskId" IN (${idsToDelete})`);
    psql(`DELETE FROM worker_activities WHERE "taskId" IN (${idsToDelete})`);
    psql(`DELETE FROM verification_tasks WHERE id IN (${idsToDelete})`);
  }

  totalDeleted += safeToDelete.length;
  totalKept++;
}

console.log(`\nDone. Groups processed: ${totalKept}, Duplicate tasks deleted: ${totalDeleted}`);
