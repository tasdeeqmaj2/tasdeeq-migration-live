/**
 * Find all workers missing on production vs local, with their verifications.
 *
 * Usage:
 *   DATABASE_URL="..." node diagnose-missing-workers.js
 */

const { Client } = require('pg');

const LOCAL_URL = 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
const PROD_URL = process.env.DATABASE_URL;

if (!PROD_URL) {
  console.error('Set DATABASE_URL env var for production.');
  process.exit(1);
}

async function main() {
  const local = new Client({ connectionString: LOCAL_URL });
  const prod = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await local.connect();
  await prod.connect();
  console.log('Connected to both DBs.\n');

  // Get all workers from local with their company and verifications
  const localQuery = `
    SELECT w.id, w.name, w.cnic, w.email, w.mobile, w."companyId",
           c.name AS company_name,
           COUNT(vt.id)::int AS task_count,
           STRING_AGG(DISTINCT vt.status, ', ') AS statuses,
           STRING_AGG(DISTINCT vt.type, ', ') AS types
    FROM workers w
    JOIN companies c ON c.id = w."companyId"
    LEFT JOIN verification_tasks vt ON vt."workerId" = w.id
    GROUP BY w.id, w.name, w.cnic, w.email, w.mobile, w."companyId", c.name
    ORDER BY c.name, w.name
  `;

  const localWorkers = (await local.query(localQuery)).rows;

  // Get all worker IDs and CNICs on prod
  const prodWorkerIds = new Set((await prod.query(`SELECT id FROM workers`)).rows.map(r => r.id));
  const prodWorkerCnics = new Set(
    (await prod.query(`SELECT cnic FROM workers WHERE cnic IS NOT NULL AND cnic != ''`)).rows.map(r => r.cnic)
  );

  // Also get prod verification task worker IDs
  const prodTaskWorkerIds = new Set(
    (await prod.query(`SELECT DISTINCT "workerId" FROM verification_tasks`)).rows.map(r => r.workerId)
  );

  // Find missing workers
  const missingById = localWorkers.filter(w => !prodWorkerIds.has(w.id));
  const missingByCnic = localWorkers.filter(w => w.cnic && !prodWorkerCnics.has(w.cnic) && !prodWorkerIds.has(w.id));
  const presentByCnicButDiffId = missingById.filter(w => w.cnic && prodWorkerCnics.has(w.cnic));

  console.log(`=== SUMMARY ===`);
  console.log(`Total local workers: ${localWorkers.length}`);
  console.log(`Total prod workers: ${prodWorkerIds.size}`);
  console.log(`Missing on prod (by ID): ${missingById.length}`);
  console.log(`Missing on prod (by CNIC, truly absent): ${missingByCnic.length}`);
  console.log(`Missing ID but CNIC exists on prod (different worker row): ${presentByCnicButDiffId.length}`);

  // Detail: workers missing by ID
  if (missingById.length > 0) {
    console.log(`\n=== WORKERS MISSING ON PROD (by ID) — ${missingById.length} total ===`);
    console.log('Worker ID | Name | CNIC | Company | Tasks | Statuses | CNIC on prod?');
    console.log('-'.repeat(120));
    for (const w of missingById) {
      const cnicOnProd = w.cnic && prodWorkerCnics.has(w.cnic) ? 'YES' : 'no';
      console.log(
        `${w.id} | ${(w.name || '').padEnd(25)} | ${(w.cnic || 'NULL').padEnd(15)} | ${(w.company_name || '').padEnd(30)} | ${w.task_count} | ${w.statuses || 'none'} | ${cnicOnProd}`
      );
    }
  }

  // Check which companies these missing workers belong to — do the companies exist on prod?
  const missingCompanyIds = [...new Set(missingById.map(w => w.companyId))];
  if (missingCompanyIds.length > 0) {
    const ph = missingCompanyIds.map((_, i) => `$${i + 1}`).join(',');
    const prodCompanies = (await prod.query(
      `SELECT id, name FROM companies WHERE id IN (${ph})`, missingCompanyIds
    )).rows;
    const prodCompanyIds = new Set(prodCompanies.map(c => c.id));
    const missingCompanies = missingCompanyIds.filter(id => !prodCompanyIds.has(id));

    console.log(`\n=== COMPANIES OF MISSING WORKERS ===`);
    console.log(`Unique companies: ${missingCompanyIds.length}`);
    console.log(`Companies exist on prod: ${prodCompanies.length}`);
    console.log(`Companies ALSO missing on prod: ${missingCompanies.length}`);

    if (missingCompanies.length > 0) {
      // Get company details from local
      const ph2 = missingCompanies.map((_, i) => `$${i + 1}`).join(',');
      const compDetails = (await local.query(
        `SELECT c.id, c.name, c."isConsumer",
                COUNT(DISTINCT w.id)::int AS worker_count,
                COUNT(DISTINCT vt.id)::int AS task_count
         FROM companies c
         LEFT JOIN workers w ON w."companyId" = c.id
         LEFT JOIN verification_tasks vt ON vt."companyId" = c.id
         WHERE c.id IN (${ph2})
         GROUP BY c.id, c.name, c."isConsumer"
         ORDER BY c.name`,
        missingCompanies
      )).rows;

      console.log('\nMissing companies detail:');
      for (const c of compDetails) {
        console.log(`  ${c.id} | ${c.name} | consumer: ${c.isConsumer} | workers: ${c.worker_count} | tasks: ${c.task_count}`);
      }
    }
  }

  // Check verification tasks for missing workers
  console.log(`\n=== VERIFICATION TASKS OF MISSING WORKERS ===`);
  const missingWorkerIds = missingById.map(w => w.id);
  if (missingWorkerIds.length > 0) {
    const ph = missingWorkerIds.map((_, i) => `$${i + 1}`).join(',');
    const tasks = (await local.query(
      `SELECT vt.id, vt.status, vt.type, vt."workerId", vt."companyId",
              w.name AS worker_name, w.cnic, c.name AS company_name,
              cf.id AS form_id,
              cf."cnicFrontImage" IS NOT NULL AND cf."cnicFrontImage" != '' AS has_cnic_front,
              cf."cnicBackImage" IS NOT NULL AND cf."cnicBackImage" != '' AS has_cnic_back,
              cf."workerPhoto" IS NOT NULL AND cf."workerPhoto" != '' AS has_photo
       FROM verification_tasks vt
       JOIN workers w ON w.id = vt."workerId"
       JOIN companies c ON c.id = vt."companyId"
       LEFT JOIN criminal_verification_forms cf ON cf."taskId" = vt.id
       WHERE vt."workerId" IN (${ph})
       ORDER BY vt.status, c.name`,
      missingWorkerIds
    )).rows;

    const byStatus = {};
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    }

    console.log(`Total tasks: ${tasks.length}`);
    console.log('By status:', Object.entries(byStatus).map(([s, c]) => `${s}: ${c}`).join(', '));

    // Check which of these tasks exist on prod
    const taskIds = tasks.map(t => t.id);
    if (taskIds.length > 0) {
      const ph2 = taskIds.map((_, i) => `$${i + 1}`).join(',');
      const prodTasks = (await prod.query(
        `SELECT id, status FROM verification_tasks WHERE id IN (${ph2})`, taskIds
      )).rows;
      const prodTaskIds = new Set(prodTasks.map(t => t.id));
      const missingTasks = tasks.filter(t => !prodTaskIds.has(t.id));

      console.log(`\nTasks also missing on prod: ${missingTasks.length} / ${tasks.length}`);
      if (missingTasks.length > 0) {
        console.log('\nTask ID | Status | Worker | CNIC | Company | Form | Images');
        console.log('-'.repeat(140));
        for (const t of missingTasks) {
          const imgs = [
            t.has_cnic_front ? 'front' : '',
            t.has_cnic_back ? 'back' : '',
            t.has_photo ? 'photo' : '',
          ].filter(Boolean).join('+') || 'none';
          console.log(
            `${t.id} | ${t.status.padEnd(12)} | ${(t.worker_name || '').padEnd(25)} | ${(t.cnic || '').padEnd(15)} | ${(t.company_name || '').padEnd(30)} | ${t.form_id ? 'yes' : 'no'} | ${imgs}`
          );
        }
      }
    }
  }

  // Also check: workers that exist on prod but have missing verification tasks
  console.log('\n=== VERIFICATION TASKS MISSING ON PROD (workers exist) ===');
  const allLocalTasks = (await local.query(`SELECT id FROM verification_tasks`)).rows.map(r => r.id);
  const allProdTasks = new Set((await prod.query(`SELECT id FROM verification_tasks`)).rows.map(r => r.id));
  const missingTaskIds = allLocalTasks.filter(id => !allProdTasks.has(id));
  console.log(`Total local tasks: ${allLocalTasks.length}`);
  console.log(`Total prod tasks: ${allProdTasks.size}`);
  console.log(`Tasks missing on prod: ${missingTaskIds.length}`);

  if (missingTaskIds.length > 0 && missingTaskIds.length <= 500) {
    const ph = missingTaskIds.map((_, i) => `$${i + 1}`).join(',');
    const details = (await local.query(
      `SELECT vt.id, vt.status, vt.type, w.name, w.cnic, c.name AS company_name
       FROM verification_tasks vt
       JOIN workers w ON w.id = vt."workerId"
       JOIN companies c ON c.id = vt."companyId"
       WHERE vt.id IN (${ph})
       ORDER BY vt.status, c.name`,
      missingTaskIds
    )).rows;

    const byStatus2 = {};
    for (const t of details) {
      byStatus2[t.status] = (byStatus2[t.status] || 0) + 1;
    }
    console.log('By status:', Object.entries(byStatus2).map(([s, c]) => `${s}: ${c}`).join(', '));

    if (details.length <= 50) {
      for (const t of details) {
        console.log(`  ${t.id} | ${t.status} | ${t.name} | ${t.cnic} | ${t.company_name}`);
      }
    }
  }

  // Check verifications that EXIST on prod but have missing images compared to local
  console.log('\n=== EXISTING VERIFICATIONS WITH MISSING IMAGES ON PROD ===');
  const localImgs = (await local.query(`
    SELECT cf."taskId", cf."cnicFrontImage", cf."cnicBackImage", cf."workerPhoto",
           w.name AS worker_name, w.cnic, c.name AS company_name, vt.status
    FROM criminal_verification_forms cf
    JOIN verification_tasks vt ON vt.id = cf."taskId"
    JOIN workers w ON w.id = vt."workerId"
    JOIN companies c ON c.id = vt."companyId"
    WHERE (cf."cnicFrontImage" IS NOT NULL AND cf."cnicFrontImage" != '')
       OR (cf."cnicBackImage" IS NOT NULL AND cf."cnicBackImage" != '')
       OR (cf."workerPhoto" IS NOT NULL AND cf."workerPhoto" != '')
  `)).rows;

  // Get all prod forms in one query
  const prodForms = (await prod.query(`
    SELECT cf."taskId", cf."cnicFrontImage", cf."cnicBackImage", cf."workerPhoto"
    FROM criminal_verification_forms cf
  `)).rows;
  const prodFormMap = Object.fromEntries(prodForms.map(f => [f.taskId, f]));

  let missingImgCount = 0;
  const missingImgDetails = [];

  for (const lf of localImgs) {
    const pf = prodFormMap[lf.taskId];
    if (!pf) continue; // form doesn't exist on prod at all — covered above

    const missing = [];
    if (lf.cnicFrontImage && (!pf.cnicFrontImage || pf.cnicFrontImage === '')) {
      missing.push('cnicFront');
    }
    if (lf.cnicBackImage && (!pf.cnicBackImage || pf.cnicBackImage === '')) {
      missing.push('cnicBack');
    }
    if (lf.workerPhoto && (!pf.workerPhoto || pf.workerPhoto === '')) {
      missing.push('photo');
    }

    if (missing.length > 0) {
      missingImgCount++;
      missingImgDetails.push({
        taskId: lf.taskId,
        worker: lf.worker_name,
        cnic: lf.cnic,
        company: lf.company_name,
        status: lf.status,
        missing,
        localFront: lf.cnicFrontImage || 'NULL',
        localBack: lf.cnicBackImage || 'NULL',
        localPhoto: lf.workerPhoto || 'NULL',
        prodFront: pf.cnicFrontImage || 'NULL',
        prodBack: pf.cnicBackImage || 'NULL',
        prodPhoto: pf.workerPhoto || 'NULL',
      });
    }
  }

  console.log(`Verifications on prod with missing images (local has them): ${missingImgCount}`);
  if (missingImgDetails.length > 0) {
    console.log('\nTask ID | Status | Worker | CNIC | Company | Missing | Local paths → Prod paths');
    console.log('-'.repeat(160));
    for (const d of missingImgDetails) {
      console.log(
        `${d.taskId} | ${d.status.padEnd(12)} | ${(d.worker || '').padEnd(20)} | ${(d.cnic || '').padEnd(15)} | ${(d.company || '').padEnd(25)} | ${d.missing.join(',')} `
      );
      if (d.missing.includes('cnicFront')) console.log(`    cnicFront: local="${d.localFront}" prod="${d.prodFront}"`);
      if (d.missing.includes('cnicBack')) console.log(`    cnicBack:  local="${d.localBack}" prod="${d.prodBack}"`);
      if (d.missing.includes('photo')) console.log(`    photo:     local="${d.localPhoto}" prod="${d.prodPhoto}"`);
    }
  }

  // Also check worker-level images (worker photo stored on worker row)
  console.log('\n=== WORKER PHOTOS MISSING ON PROD (worker.photo column) ===');
  const localWorkerPhotos = (await local.query(`
    SELECT w.id, w.name, w.cnic, w.photo, c.name AS company_name
    FROM workers w
    JOIN companies c ON c.id = w."companyId"
    WHERE w.photo IS NOT NULL AND w.photo != ''
  `)).rows;

  const prodWorkerPhotos = (await prod.query(`
    SELECT id, photo FROM workers WHERE photo IS NOT NULL AND photo != ''
  `)).rows;
  const prodWorkerPhotoMap = Object.fromEntries(prodWorkerPhotos.map(w => [w.id, w.photo]));

  let missingWorkerPhotoCount = 0;
  for (const lw of localWorkerPhotos) {
    if (prodWorkerIds.has(lw.id) && !prodWorkerPhotoMap[lw.id]) {
      missingWorkerPhotoCount++;
      if (missingWorkerPhotoCount <= 20) {
        console.log(`  ${lw.id} | ${lw.name} | ${lw.cnic} | ${lw.company_name} | local: ${lw.photo}`);
      }
    }
  }
  console.log(`Total workers on prod missing photo: ${missingWorkerPhotoCount}`);

  await local.end();
  await prod.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
