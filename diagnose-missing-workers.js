/**
 * Diagnose missing workers, verifications, and images on production vs local,
 * and cross-reference with the old (legacy) DB to find the source data.
 *
 * Usage (on server):
 *   DATABASE_URL="<prod>" OLD_DATABASE_URL="<old-prod>" node diagnose-missing-workers.js
 *
 * Usage (local — reads .env automatically for OLD, hardcodes local new DB):
 *   node diagnose-missing-workers.js
 *
 * Add --prod to use DATABASE_URL for the new DB (with SSL).
 */

const { Client } = require('pg');

const PROD = process.argv.includes('--prod');

const LOCAL_NEW_URL = 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';

// For prod: pass DATABASE_URL and OLD_DATABASE_URL as env vars
// For local: reads old from .env, new is hardcoded
let NEW_URL, OLD_URL;
if (PROD) {
  NEW_URL = process.env.DATABASE_URL;
  OLD_URL = process.env.OLD_DATABASE_URL;
  if (!NEW_URL) { console.error('Set DATABASE_URL for production new DB'); process.exit(1); }
  if (!OLD_URL) { console.error('Set OLD_DATABASE_URL for production old DB'); process.exit(1); }
} else {
  require('dotenv').config();
  NEW_URL = LOCAL_NEW_URL;
  OLD_URL = process.env.OLD_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5432/tasdeeq-prod-dump';
}

async function connect(url, name, ssl) {
  const c = new Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : false });
  await c.connect();
  console.log(`Connected to ${name}`);
  return c;
}

async function main() {
  const newDb = await connect(NEW_URL, PROD ? 'PRODUCTION (new)' : 'LOCAL (new)', PROD);
  const oldDb = await connect(OLD_URL, PROD ? 'PRODUCTION (old)' : 'LOCAL (old)', PROD);

  // Load worker map if available (old employment id → new worker id)
  let workerMap = {};
  try { workerMap = require('./maps/workerMap.json'); } catch (e) {}
  const workerMapSize = Object.keys(workerMap).length;
  console.log(`Worker map entries: ${workerMapSize}\n`);

  // === 1. Table counts ===
  console.log('=== TABLE COUNTS (new DB) ===');
  const tables = ['users','companies','corporate_users','workers','verification_tasks','criminal_verification_forms','invoices','credit_statuses'];
  for (const t of tables) {
    try {
      const { rows: [{ cnt }] } = await newDb.query(`SELECT COUNT(*)::int AS cnt FROM "${t}"`);
      console.log(`  ${t}: ${cnt}`);
    } catch (e) { console.log(`  ${t}: ERROR`); }
  }

  // === 2. Old DB counts ===
  console.log('\n=== OLD DB COUNTS ===');
  const oldTables = [
    ['user_worker_employment', 'Total employments (workers)'],
    ['worker', 'Unique workers'],
    ['user_worker_employment_document', 'Worker documents (images)'],
    ['users', 'Users'],
  ];
  for (const [t, label] of oldTables) {
    try {
      const { rows: [{ cnt }] } = await oldDb.query(`SELECT COUNT(*)::int AS cnt FROM "${t}"`);
      console.log(`  ${label} (${t}): ${cnt}`);
    } catch (e) { console.log(`  ${label} (${t}): ERROR - ${e.message.slice(0, 60)}`); }
  }

  // === 3. Find old employments NOT in new DB ===
  console.log('\n=== OLD EMPLOYMENTS MISSING IN NEW DB ===');
  const allOldEmployments = (await oldDb.query(`SELECT id FROM user_worker_employment ORDER BY id`)).rows.map(r => r.id);
  const mappedOldIds = new Set(Object.keys(workerMap).map(Number));

  const unmappedOldIds = allOldEmployments.filter(id => !mappedOldIds.has(id));
  console.log(`Total old employments: ${allOldEmployments.length}`);
  console.log(`Mapped to new DB: ${mappedOldIds.size}`);
  console.log(`Unmapped (never migrated): ${unmappedOldIds.length}`);

  if (unmappedOldIds.length > 0) {
    // Get details of unmapped from old DB
    const sample = unmappedOldIds.slice(0, 50);
    const ph = sample.map((_, i) => `$${i + 1}`).join(',');
    const unmappedDetails = (await oldDb.query(`
      SELECT e.id, e.full_name, e.user_id, w.cnic,
             e.cplc_verification_status, e.sindh_police_verification_status
      FROM user_worker_employment e
      INNER JOIN worker w ON w.id = e.worker_id
      WHERE e.id IN (${ph})
      ORDER BY e.id
    `, sample)).rows;

    console.log(`\nSample unmapped (first ${sample.length}):`);
    for (const r of unmappedDetails) {
      console.log(`  old#${r.id} | ${r.full_name || 'NULL'} | CNIC: ${r.cnic || 'NULL'} | user: ${r.user_id} | cplc: ${r.cplc_verification_status || 'NULL'} | sindh: ${r.sindh_police_verification_status || 'NULL'}`);
    }
  }

  // === 4. Workers in new DB (local) but missing on prod (if running on prod) ===
  // Skip this if not prod — both would be same DB
  // Instead, check new DB workers that have missing verification tasks
  console.log('\n=== NEW DB: WORKERS WITHOUT ANY VERIFICATION TASK ===');
  const { rows: orphanWorkers } = await newDb.query(`
    SELECT w.id, w.name, w.cnic, c.name AS company_name
    FROM workers w
    JOIN companies c ON c.id = w."companyId"
    LEFT JOIN verification_tasks vt ON vt."workerId" = w.id
    WHERE vt.id IS NULL
    LIMIT 20
  `);
  const { rows: [{ cnt: orphanCount }] } = await newDb.query(`
    SELECT COUNT(*)::int AS cnt FROM workers w
    LEFT JOIN verification_tasks vt ON vt."workerId" = w.id
    WHERE vt.id IS NULL
  `);
  console.log(`Workers with no tasks: ${orphanCount}`);
  for (const w of orphanWorkers) {
    console.log(`  ${w.id} | ${w.name} | ${w.cnic} | ${w.company_name}`);
  }

  // === 5. Verifications with missing images (new DB) ===
  console.log('\n=== VERIFICATIONS WITH MISSING IMAGES (new DB) ===');
  const { rows: imgStats } = await newDb.query(`
    SELECT
      COUNT(*)::int AS total_forms,
      SUM(CASE WHEN cf."cnicFrontImage" IS NULL OR cf."cnicFrontImage" = '' THEN 1 ELSE 0 END)::int AS no_front,
      SUM(CASE WHEN cf."cnicBackImage" IS NULL OR cf."cnicBackImage" = '' THEN 1 ELSE 0 END)::int AS no_back,
      SUM(CASE WHEN cf."workerPhoto" IS NULL OR cf."workerPhoto" = '' THEN 1 ELSE 0 END)::int AS no_photo,
      SUM(CASE WHEN (cf."cnicFrontImage" IS NULL OR cf."cnicFrontImage" = '')
                AND (cf."cnicBackImage" IS NULL OR cf."cnicBackImage" = '')
                AND (cf."workerPhoto" IS NULL OR cf."workerPhoto" = '') THEN 1 ELSE 0 END)::int AS all_missing
    FROM criminal_verification_forms cf
    JOIN verification_tasks vt ON vt.id = cf."taskId"
    WHERE vt.status IN ('PENDING', 'ASSIGNED', 'COMPLETED')
  `);
  const is = imgStats[0];
  console.log(`Total active forms: ${is.total_forms}`);
  console.log(`Missing CNIC front: ${is.no_front}`);
  console.log(`Missing CNIC back: ${is.no_back}`);
  console.log(`Missing worker photo: ${is.no_photo}`);
  console.log(`ALL images missing: ${is.all_missing}`);

  // === 6. For forms with missing images, check old DB for the source ===
  console.log('\n=== FORMS MISSING IMAGES — CHECKING OLD DB FOR SOURCE ===');

  // Get task map (old employment id → new task id)
  let taskMap = {};
  try { taskMap = require('./maps/verificationTaskMap.json'); } catch (e) {}
  const taskMapSize = Object.keys(taskMap).length;
  console.log(`Task map entries: ${taskMapSize}`);

  // Build reverse map: new task id → old employment id
  const reverseTaskMap = {};
  for (const [oldId, newId] of Object.entries(taskMap)) {
    reverseTaskMap[newId] = Number(oldId);
  }

  // Get forms with missing images
  const { rows: formsWithMissingImgs } = await newDb.query(`
    SELECT cf."taskId", cf."cnicFrontImage", cf."cnicBackImage", cf."workerPhoto",
           w.name AS worker_name, w.cnic
    FROM criminal_verification_forms cf
    JOIN verification_tasks vt ON vt.id = cf."taskId"
    JOIN workers w ON w.id = vt."workerId"
    WHERE vt.status IN ('PENDING', 'ASSIGNED', 'COMPLETED')
      AND ((cf."cnicFrontImage" IS NULL OR cf."cnicFrontImage" = '')
        OR (cf."cnicBackImage" IS NULL OR cf."cnicBackImage" = '')
        OR (cf."workerPhoto" IS NULL OR cf."workerPhoto" = ''))
  `);

  console.log(`Forms with at least one missing image: ${formsWithMissingImgs.length}`);

  // Look up old DB images for these
  let recoverable = 0;
  let notRecoverable = 0;
  const recoverableDetails = [];

  for (const f of formsWithMissingImgs) {
    const oldEmpId = reverseTaskMap[f.taskId];
    if (!oldEmpId) {
      notRecoverable++;
      continue;
    }

    // Check old DB for images
    const { rows: oldDocs } = await oldDb.query(`
      SELECT d.cnic_front_picture_link, d.cnic_back_picture_link, d.picture_link
      FROM user_worker_employment_document d
      WHERE d.user_worker_employment_id = $1
        AND d.is_active IS DISTINCT FROM false
      ORDER BY d.id DESC
      LIMIT 1
    `, [oldEmpId]);

    // Also check worker table directly
    const { rows: oldWorker } = await oldDb.query(`
      SELECT w.cnic_front_picture_link, w.cnic_back_picture_link, w.picture_link
      FROM worker w
      INNER JOIN user_worker_employment e ON e.worker_id = w.id
      WHERE e.id = $1
      LIMIT 1
    `, [oldEmpId]);

    const doc = oldDocs[0] || {};
    const wkr = oldWorker[0] || {};

    const canRecover = {
      front: (!f.cnicFrontImage || f.cnicFrontImage === '') && (doc.cnic_front_picture_link || wkr.cnic_front_picture_link),
      back: (!f.cnicBackImage || f.cnicBackImage === '') && (doc.cnic_back_picture_link || wkr.cnic_back_picture_link),
      photo: (!f.workerPhoto || f.workerPhoto === '') && (doc.picture_link || wkr.picture_link),
    };

    if (canRecover.front || canRecover.back || canRecover.photo) {
      recoverable++;
      if (recoverableDetails.length < 20) {
        recoverableDetails.push({
          taskId: f.taskId,
          worker: f.worker_name,
          cnic: f.cnic,
          oldEmpId,
          front: canRecover.front ? (doc.cnic_front_picture_link || wkr.cnic_front_picture_link) : null,
          back: canRecover.back ? (doc.cnic_back_picture_link || wkr.cnic_back_picture_link) : null,
          photo: canRecover.photo ? (doc.picture_link || wkr.picture_link) : null,
        });
      }
    } else {
      notRecoverable++;
    }
  }

  console.log(`\nRecoverable from old DB: ${recoverable}`);
  console.log(`Not recoverable (no old mapping or no old images): ${notRecoverable}`);

  if (recoverableDetails.length > 0) {
    console.log('\nSample recoverable:');
    for (const d of recoverableDetails) {
      console.log(`  Task ${d.taskId} | ${d.worker} | ${d.cnic} | old#${d.oldEmpId}`);
      if (d.front) console.log(`    → front: ${d.front}`);
      if (d.back) console.log(`    → back: ${d.back}`);
      if (d.photo) console.log(`    → photo: ${d.photo}`);
    }
  }

  // === 7. Verification tasks by status ===
  console.log('\n=== VERIFICATION TASKS BY STATUS (new DB) ===');
  const { rows: statusRows } = await newDb.query(`
    SELECT status, COUNT(*)::int AS cnt FROM verification_tasks GROUP BY status ORDER BY status
  `);
  for (const r of statusRows) {
    console.log(`  ${r.status}: ${r.cnt}`);
  }

  // === 8. Credit status check ===
  console.log('\n=== CREDIT STATUS ===');
  const { rows: [creditInfo] } = await newDb.query(`
    SELECT
      COUNT(DISTINCT c.id)::int AS total_companies,
      COUNT(DISTINCT cs.id)::int AS with_credit,
      SUM(CASE WHEN cs."availableUnits" > 0 THEN 1 ELSE 0 END)::int AS with_units
    FROM companies c
    LEFT JOIN credit_statuses cs ON cs."companyId" = c.id
  `);
  console.log(`Total companies: ${creditInfo.total_companies}`);
  console.log(`With credit_status: ${creditInfo.with_credit}`);
  console.log(`With available units > 0: ${creditInfo.with_units}`);

  // === 9. Worker photo column check ===
  console.log('\n=== WORKER PHOTOS (worker.photo column) ===');
  const { rows: [photoStats] } = await newDb.query(`
    SELECT COUNT(*)::int AS total,
           SUM(CASE WHEN photo IS NOT NULL AND photo != '' THEN 1 ELSE 0 END)::int AS with_photo
    FROM workers
  `);
  console.log(`Total workers: ${photoStats.total}`);
  console.log(`With photo: ${photoStats.with_photo}`);
  console.log(`Without photo: ${photoStats.total - photoStats.with_photo}`);

  await newDb.end();
  await oldDb.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
