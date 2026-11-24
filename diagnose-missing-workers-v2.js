/**
 * Diagnose missing workers & verifications by CNIC-matching old DB ↔ new DB.
 *
 * Checks:
 *  1. Old DB employments whose CNIC has NO worker in new DB (never migrated)
 *  2. New DB orphan workers (exist but have no verification task)
 *     — and whether the old DB had verification data for them
 *  3. Summary of what's recoverable
 *
 * Usage:
 *   node diagnose-missing-workers-v2.js                       # local
 *   DATABASE_URL="<new>" OLD_DATABASE_URL="<old>" node diagnose-missing-workers-v2.js --prod
 */

const { Client } = require('pg');
const { decryptLegacy } = require('./utils/decrypt');

const PROD = process.argv.includes('--prod');

let NEW_URL, OLD_URL;
if (PROD) {
  NEW_URL = process.env.DATABASE_URL;
  OLD_URL = process.env.OLD_DATABASE_URL;
} else {
  require('dotenv').config();
  NEW_URL = 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
  OLD_URL = process.env.OLD_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5432/tasdeeq-prod-dump';
}

if (!NEW_URL || !OLD_URL) {
  console.error('Set DATABASE_URL and OLD_DATABASE_URL');
  process.exit(1);
}

function decryptCnic(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  return decryptLegacy(s);
}

function normalize(cnic) {
  if (!cnic) return null;
  return cnic.replace(/[-\s]/g, '');
}

async function main() {
  const newDb = new Client({ connectionString: NEW_URL, ssl: PROD ? { rejectUnauthorized: false } : false });
  const oldDb = new Client({ connectionString: OLD_URL, ssl: PROD ? { rejectUnauthorized: false } : false });
  await newDb.connect();
  await oldDb.connect();
  console.log(`${PROD ? '[PROD]' : '[LOCAL]'} Connected.\n`);

  // ============================================================
  // STEP 1: Load all CNICs from new DB (workers + their task counts)
  // ============================================================
  console.log('Loading new DB workers...');
  const { rows: newWorkers } = await newDb.query(`
    SELECT w.id, w.cnic, w.name, w."companyId", c.name AS company_name,
           COUNT(vt.id)::int AS task_count
    FROM workers w
    JOIN companies c ON c.id = w."companyId"
    LEFT JOIN verification_tasks vt ON vt."workerId" = w.id
    WHERE w.cnic IS NOT NULL AND w.cnic != ''
    GROUP BY w.id, w.cnic, w.name, w."companyId", c.name
  `);
  console.log(`New DB workers with CNIC: ${newWorkers.length}`);

  const newCnicMap = new Map(); // normalized cnic → [{ id, name, companyId, taskCount }]
  let orphanCount = 0;
  for (const w of newWorkers) {
    const nc = normalize(w.cnic);
    if (!nc) continue;
    if (!newCnicMap.has(nc)) newCnicMap.set(nc, []);
    newCnicMap.get(nc).push({
      id: w.id,
      name: w.name,
      companyId: w.companyId,
      companyName: w.company_name,
      taskCount: w.task_count,
    });
    if (w.task_count === 0) orphanCount++;
  }
  console.log(`New DB unique CNICs: ${newCnicMap.size}`);
  console.log(`New DB orphan workers (no tasks): ${orphanCount}\n`);

  // ============================================================
  // STEP 2: Load all old DB employments with their verification data
  // ============================================================
  console.log('Loading old DB employments...');
  const { rows: oldEmployments } = await oldDb.query(`
    SELECT e.id AS emp_id, e.full_name, e.user_id,
           w.id AS worker_id, w.cnic,
           e.cplc_verification_status, e.sindh_police_verification_status,
           w.created_at,
           w.cnic_front_picture_link, w.cnic_back_picture_link, w.picture_link
    FROM user_worker_employment e
    JOIN worker w ON w.id = e.worker_id
    WHERE w.cnic IS NOT NULL AND w.cnic != ''
  `);
  console.log(`Old DB employments: ${oldEmployments.length}`);

  // Decrypt and normalize old CNICs, build map
  const oldCnicMap = new Map(); // normalized cnic → [employment records]
  let decryptFail = 0;
  for (const e of oldEmployments) {
    const raw = decryptCnic(e.cnic);
    if (!raw) { decryptFail++; continue; }
    const nc = normalize(raw);
    if (!nc || nc.length < 10) { decryptFail++; continue; }
    if (!oldCnicMap.has(nc)) oldCnicMap.set(nc, []);
    oldCnicMap.get(nc).push({
      empId: e.emp_id,
      fullName: e.full_name,
      userId: e.user_id,
      workerId: e.worker_id,
      cplcStatus: e.cplc_verification_status,
      sindhStatus: e.sindh_police_verification_status,
      createdAt: e.created_at,
      hasFront: !!e.cnic_front_picture_link,
      hasBack: !!e.cnic_back_picture_link,
      hasPhoto: !!e.picture_link,
    });
  }
  console.log(`Old DB unique CNICs (decrypted): ${oldCnicMap.size}`);
  console.log(`Old DB decrypt failures: ${decryptFail}\n`);

  // Also load old employment documents for image check
  console.log('Loading old DB employment documents...');
  const { rows: oldDocs } = await oldDb.query(`
    SELECT d.user_worker_employment_id AS emp_id,
           d.cnic_front_picture_link, d.cnic_back_picture_link, d.picture_link
    FROM user_worker_employment_document d
    WHERE d.is_active IS DISTINCT FROM false
  `);
  console.log(`Old DB documents: ${oldDocs.length}\n`);

  // Build emp_id → has images from documents
  const oldDocMap = new Map();
  for (const d of oldDocs) {
    if (!oldDocMap.has(d.emp_id)) {
      oldDocMap.set(d.emp_id, { hasFront: false, hasBack: false, hasPhoto: false });
    }
    const ex = oldDocMap.get(d.emp_id);
    if (d.cnic_front_picture_link) ex.hasFront = true;
    if (d.cnic_back_picture_link) ex.hasBack = true;
    if (d.picture_link) ex.hasPhoto = true;
  }

  // ============================================================
  // STEP 3: Find old CNICs completely missing from new DB
  // ============================================================
  console.log('=== OLD DB EMPLOYMENTS NOT IN NEW DB (by CNIC) ===');
  let missingFromNew = 0;
  let missingWithVerification = 0;
  let missingWithImages = 0;
  const missingSamples = [];

  for (const [cnic, emps] of oldCnicMap) {
    if (newCnicMap.has(cnic)) continue;
    missingFromNew += emps.length;
    for (const e of emps) {
      const hasVerification = e.cplcStatus || e.sindhStatus;
      if (hasVerification) missingWithVerification++;
      const docImages = oldDocMap.get(e.empId) || {};
      const hasAnyImage = e.hasFront || e.hasBack || e.hasPhoto || docImages.hasFront || docImages.hasBack || docImages.hasPhoto;
      if (hasAnyImage) missingWithImages++;
      if (missingSamples.length < 20) {
        missingSamples.push({
          cnic,
          name: e.fullName,
          empId: e.empId,
          cplc: e.cplcStatus || '-',
          sindh: e.sindhStatus || '-',
          images: hasAnyImage ? 'YES' : 'NO',
        });
      }
    }
  }

  const missingUniqueCnics = [...oldCnicMap.keys()].filter(c => !newCnicMap.has(c)).length;
  console.log(`Unique CNICs in old DB but NOT in new DB: ${missingUniqueCnics}`);
  console.log(`Total old employments missing: ${missingFromNew}`);
  console.log(`  — with CPLC/Sindh verification data: ${missingWithVerification}`);
  console.log(`  — with images (worker or document): ${missingWithImages}`);

  if (missingSamples.length > 0) {
    console.log(`\nSample missing (first ${missingSamples.length}):`);
    for (const s of missingSamples) {
      console.log(`  CNIC: ${s.cnic} | ${s.name || 'NULL'} | old#${s.empId} | cplc: ${s.cplc} | sindh: ${s.sindh} | images: ${s.images}`);
    }
  }

  // Breakdown of missing by verification status
  const missingByStatus = {};
  for (const [cnic, emps] of oldCnicMap) {
    if (newCnicMap.has(cnic)) continue;
    for (const e of emps) {
      const key = `cplc:${e.cplcStatus || 'NULL'} / sindh:${e.sindhStatus || 'NULL'}`;
      missingByStatus[key] = (missingByStatus[key] || 0) + 1;
    }
  }
  console.log('\nMissing by verification status:');
  for (const [status, count] of Object.entries(missingByStatus).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${status}: ${count}`);
  }

  // ============================================================
  // STEP 4: Orphan workers in new DB — check if old DB has data
  // ============================================================
  console.log('\n=== NEW DB ORPHAN WORKERS (no verification tasks) ===');
  const orphans = newWorkers.filter(w => w.task_count === 0);
  let orphanInOld = 0;
  let orphanInOldWithVerification = 0;
  let orphanNotInOld = 0;
  const orphanSamples = [];

  for (const w of orphans) {
    const nc = normalize(w.cnic);
    if (!nc) continue;
    const oldEmps = oldCnicMap.get(nc);
    if (oldEmps && oldEmps.length > 0) {
      orphanInOld++;
      const hasVerification = oldEmps.some(e => e.cplcStatus || e.sindhStatus);
      if (hasVerification) orphanInOldWithVerification++;
      if (orphanSamples.length < 15) {
        orphanSamples.push({
          newId: w.id,
          cnic: nc,
          name: w.name,
          company: w.company_name,
          oldEmpCount: oldEmps.length,
          oldVerification: hasVerification ? 'YES' : 'NO',
        });
      }
    } else {
      orphanNotInOld++;
    }
  }

  console.log(`Total orphan workers: ${orphans.length}`);
  console.log(`  — found in old DB: ${orphanInOld}`);
  console.log(`    — with verification data: ${orphanInOldWithVerification}`);
  console.log(`  — NOT found in old DB: ${orphanNotInOld} (created in new system, never submitted)`);

  if (orphanSamples.length > 0) {
    console.log(`\nSample orphans found in old DB:`);
    for (const s of orphanSamples) {
      console.log(`  new#${s.newId} | ${s.name} (${s.cnic}) | ${s.company} | old emps: ${s.oldEmpCount} | verification: ${s.oldVerification}`);
    }
  }

  // ============================================================
  // STEP 5: New DB workers WITH tasks — check for missing verification forms
  // ============================================================
  console.log('\n=== NEW DB TASKS WITHOUT CRIMINAL FORMS ===');
  const { rows: [formStats] } = await newDb.query(`
    SELECT
      COUNT(vt.id)::int AS total_tasks,
      COUNT(cf.id)::int AS with_form,
      (COUNT(vt.id) - COUNT(cf.id))::int AS without_form
    FROM verification_tasks vt
    LEFT JOIN criminal_verification_forms cf ON cf."taskId" = vt.id
  `);
  console.log(`Total tasks: ${formStats.total_tasks}`);
  console.log(`With criminal form: ${formStats.with_form}`);
  console.log(`Without criminal form: ${formStats.without_form}`);

  // ============================================================
  // STEP 6: Overall summary
  // ============================================================
  console.log('\n========================================');
  console.log('           RECOVERY SUMMARY');
  console.log('========================================');
  console.log(`Old DB unique CNICs: ${oldCnicMap.size}`);
  console.log(`New DB unique CNICs: ${newCnicMap.size}`);
  console.log(`CNICs in both: ${[...oldCnicMap.keys()].filter(c => newCnicMap.has(c)).length}`);
  console.log(`CNICs only in old DB: ${missingUniqueCnics}  ← never migrated`);
  console.log(`CNICs only in new DB: ${[...newCnicMap.keys()].filter(c => !oldCnicMap.has(c)).length}  ← created in new system`);
  console.log('');
  console.log(`Orphan workers (new DB, no tasks): ${orphans.length}`);
  console.log(`  Recoverable from old DB: ${orphanInOld} (${orphanInOldWithVerification} with verification data)`);
  console.log(`  New-system only (no old data): ${orphanNotInOld}`);
  console.log('');
  console.log(`Never-migrated old employments: ${missingFromNew}`);
  console.log(`  With verification results: ${missingWithVerification}`);
  console.log(`  With images: ${missingWithImages}`);

  await newDb.end();
  await oldDb.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
