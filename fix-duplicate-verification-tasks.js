/**
 * Fix duplicate verification tasks — same CNIC verified multiple times
 * for the same company (created during migration with duplicate worker records).
 *
 * Strategy: For each (cnic, companyId, type='CRIMINAL') group with >1 task,
 * keep the most progressed / most recent task and delete the others.
 * Also merges duplicate worker records for the same CNIC+company.
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
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    ).trim();
  }
  return execSync(
    `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -t -A -F "||" -c "${escaped.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  ).trim();
}

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${PROD ? '[PRODUCTION] ' : '[LOCAL] '}`);

// Step 1: Count current PENDING/ASSIGNED tasks in CPLC queue
const queueCount = psql(`
  SELECT status, COUNT(*) FROM verification_tasks
  WHERE type = 'CRIMINAL' AND status IN ('PENDING', 'ASSIGNED', 'COMPLETED')
  GROUP BY status ORDER BY status
`);
console.log('Current CPLC queue:');
queueCount.split('\n').filter(Boolean).forEach(r => {
  const [status, cnt] = r.split('||');
  console.log(`  ${status}: ${cnt}`);
});

// Step 2: Find duplicate groups by CNIC + company
console.log('\nFinding duplicate CRIMINAL tasks (same CNIC + company)...\n');

const dupes = psql(`
  SELECT w.cnic, vt."companyId", COUNT(*) AS cnt,
         MIN(w.name) AS worker_name, MIN(c.name) AS company_name
  FROM verification_tasks vt
  JOIN workers w ON w.id = vt."workerId"
  JOIN companies c ON c.id = vt."companyId"
  WHERE vt.type = 'CRIMINAL'
    AND w.cnic IS NOT NULL AND w.cnic != ''
  GROUP BY w.cnic, vt."companyId"
  HAVING COUNT(*) > 1
  ORDER BY COUNT(*) DESC
`);

if (!dupes) {
  console.log('No duplicate verification tasks found.');
  process.exit(0);
}

const groups = dupes.split('\n').filter(Boolean).map(r => {
  const [cnic, companyId, cnt, workerName, companyName] = r.split('||');
  return { cnic, companyId, count: parseInt(cnt), workerName, companyName };
});

console.log(`Found ${groups.length} CNIC-company pairs with duplicate tasks.`);
const totalDupes = groups.reduce((s, g) => s + g.count - 1, 0);
console.log(`Total duplicate tasks to remove: ${totalDupes}\n`);

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
let totalSkippedInvoice = 0;
let totalKept = 0;

for (const g of groups) {
  const tasks = psql(`
    SELECT vt.id, vt.status, vt."createdAt", vt."workerId",
           CASE WHEN cf.id IS NOT NULL THEN 1 ELSE 0 END AS has_form,
           CASE WHEN cr.id IS NOT NULL THEN 1 ELSE 0 END AS has_cplc_review,
           CASE WHEN ii.id IS NOT NULL THEN 1 ELSE 0 END AS has_invoice_item
    FROM verification_tasks vt
    JOIN workers w ON w.id = vt."workerId"
    LEFT JOIN criminal_verification_forms cf ON cf."taskId" = vt.id
    LEFT JOIN cplc_verification_reviews cr ON cr."taskId" = vt.id
    LEFT JOIN invoice_items ii ON ii."taskId" = vt.id
    WHERE w.cnic = '${g.cnic}'
      AND vt."companyId" = '${g.companyId}'
      AND vt.type = 'CRIMINAL'
    ORDER BY vt."createdAt" DESC
  `);

  const taskList = tasks.split('\n').filter(Boolean).map(r => {
    const [id, status, createdAt, workerId, hasForm, hasCplcReview, hasInvoiceItem] = r.split('||');
    return {
      id, status, createdAt, workerId,
      hasForm: hasForm === '1',
      hasCplcReview: hasCplcReview === '1',
      hasInvoiceItem: hasInvoiceItem === '1',
      priority: STATUS_PRIORITY[status] || 0,
    };
  });

  // Sort: highest status priority first, then has CPLC review, then has form, then most recent
  taskList.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.hasCplcReview !== a.hasCplcReview) return b.hasCplcReview ? 1 : -1;
    if (b.hasForm !== a.hasForm) return b.hasForm ? 1 : -1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const keep = taskList[0];
  const toDelete = taskList.slice(1);

  // Don't delete tasks that have invoice items
  const safeToDelete = toDelete.filter(t => !t.hasInvoiceItem);
  const unsafe = toDelete.filter(t => t.hasInvoiceItem);

  if (unsafe.length > 0) {
    totalSkippedInvoice += unsafe.length;
  }

  if (safeToDelete.length === 0) continue;

  if (totalKept < 20) {
    console.log(`${DRY_RUN ? '[DRY] ' : ''}CNIC ${g.cnic} @ ${g.companyName}: keep ${keep.id} (${keep.status}), delete ${safeToDelete.length} dupe(s)${unsafe.length ? ` (${unsafe.length} skipped - invoiced)` : ''}`);
  }

  if (!DRY_RUN) {
    const idsToDelete = safeToDelete.map(t => `'${t.id}'`).join(',');
    const workerIdsToDelete = [...new Set(safeToDelete.map(t => t.workerId).filter(wid => wid !== keep.workerId))];

    // Delete related records first
    psql(`DELETE FROM criminal_verification_forms WHERE "taskId" IN (${idsToDelete})`);
    psql(`DELETE FROM cplc_verification_reviews WHERE "taskId" IN (${idsToDelete})`);
    psql(`DELETE FROM verification_form_drafts WHERE "taskId" IN (${idsToDelete})`);
    psql(`DELETE FROM worker_activities WHERE "taskId" IN (${idsToDelete})`);
    psql(`DELETE FROM notifications WHERE data->>'taskId' IN (${idsToDelete})`);
    psql(`DELETE FROM verification_tasks WHERE id IN (${idsToDelete})`);

    // Delete orphan worker records (workers that no longer have any tasks)
    if (workerIdsToDelete.length > 0) {
      const wids = workerIdsToDelete.map(w => `'${w}'`).join(',');
      psql(`
        DELETE FROM workers WHERE id IN (${wids})
        AND NOT EXISTS (SELECT 1 FROM verification_tasks vt WHERE vt."workerId" = workers.id)
      `);
    }
  }

  totalDeleted += safeToDelete.length;
  totalKept++;
}

console.log(`\n=== SUMMARY ===`);
console.log(`Duplicate groups: ${groups.length}`);
console.log(`Tasks deleted: ${totalDeleted}`);
console.log(`Tasks skipped (have invoice): ${totalSkippedInvoice}`);

// Show new queue count
if (!DRY_RUN) {
  console.log('\nNew CPLC queue:');
  const newCount = psql(`
    SELECT status, COUNT(*) FROM verification_tasks
    WHERE type = 'CRIMINAL' AND status IN ('PENDING', 'ASSIGNED', 'COMPLETED')
    GROUP BY status ORDER BY status
  `);
  newCount.split('\n').filter(Boolean).forEach(r => {
    const [status, cnt] = r.split('||');
    console.log(`  ${status}: ${cnt}`);
  });
}
