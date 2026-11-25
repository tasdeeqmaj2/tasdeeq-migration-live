/**
 * Create criminal_verification_forms + cplc_verification_reviews
 * for verification_tasks that are missing them.
 *
 * Matches back to old DB via worker CNIC + company->old user mapping.
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');
const { decryptIfEncrypted, looksEncrypted, isValidEmail } = require('./utils/decrypt');
const { normalizeLegacyFileRef } = require('./utils/legacyFiles');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
const NEW_DB_URL = process.env.NEW_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
const BATCH_SIZE = 2000;

function cuid() { return 'c' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex'); }

const PLACEHOLDER_DOB = new Date('1900-01-01T00:00:00.000Z');
const PLACEHOLDER_CNIC_EXPIRY = new Date('2099-12-31T00:00:00.000Z');

function mapFormResult(cplc, sindh, islamabad) {
  const values = [cplc, sindh, islamabad].filter(s => s != null && String(s).trim()).map(s => String(s).toLowerCase());
  if (values.length === 0) return null;
  if (values.some(s => /reject|fail|deni|criminal/.test(s))) return 'CRIMINAL_RECORD';
  if (values.some(s => /approv|verif|complet|success|clear|pass|skip/.test(s))) return 'CLEARED';
  return null;
}

function mapCplcVerdict(status) {
  if (!status) return null;
  const s = String(status).trim().toLowerCase();
  if (!s) return null;
  if (/reject|fail|deni/.test(s)) return 'REJECTED';
  if (/skip/.test(s)) return 'SKIPPED';
  if (/approv|verif|complet|success|clear|pass/.test(s)) return 'APPROVED';
  return null;
}

function strOr(v, fb) { const s = v != null ? String(v).trim() : ''; return s || fb; }

async function run() {
  const opts = (url) => ({ connectionString: url, ssl: SSL, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
  const oldDb = new Client(opts(OLD_DB_URL));
  const newDb = new Client(opts(NEW_DB_URL));
  await oldDb.connect();
  await newDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);

  // Step 1: Find tasks without forms
  console.log('=== Step 1: Finding tasks without forms ===\n');
  const { rows: missingTasks } = await newDb.query(`
    SELECT vt.id as task_id, vt."workerId", vt."companyId", vt."createdById", vt."createdAt",
           w.cnic, w.name as worker_name
    FROM verification_tasks vt
    JOIN workers w ON w.id = vt."workerId"
    WHERE NOT EXISTS (SELECT 1 FROM criminal_verification_forms cvf WHERE cvf."taskId" = vt.id)
  `);
  console.log(`Tasks without forms: ${missingTasks.length}\n`);

  if (missingTasks.length === 0) {
    console.log('Nothing to do.');
    await oldDb.end(); await newDb.end();
    return;
  }

  // Step 2: Build company -> old user IDs mapping
  console.log('=== Step 2: Building company -> old user mapping ===\n');
  const { rows: newUsers } = await newDb.query(`
    SELECT u.email, cu."companyId" FROM users u JOIN corporate_users cu ON cu."userId" = u.id WHERE u.email IS NOT NULL
  `);
  const { rows: oldUsers } = await oldDb.query(`SELECT id, email FROM "user" WHERE email IS NOT NULL AND email != ''`);

  const emailToOldId = {};
  for (const ou of oldUsers) {
    const email = looksEncrypted(ou.email) ? decryptIfEncrypted(ou.email) : ou.email;
    if (email && isValidEmail(email)) emailToOldId[email.toLowerCase()] = ou.id;
  }

  const companyOldUsers = {};
  for (const nu of newUsers) {
    const oldId = emailToOldId[nu.email.toLowerCase()];
    if (oldId) {
      if (!companyOldUsers[nu.companyId]) companyOldUsers[nu.companyId] = [];
      companyOldUsers[nu.companyId].push(oldId);
    }
  }

  // Step 3: Load city/province lookups
  const { rows: cities } = await newDb.query('SELECT id, name, "provinceId" FROM cities');
  const cityByName = new Map();
  const provinceByCity = new Map();
  let fallbackCityId = null, fallbackProvinceId = null;
  for (const c of cities) {
    cityByName.set(c.name.trim().toLowerCase().replace(/[-\s]+/g, ' '), c.id);
    provinceByCity.set(c.id, c.provinceId);
    if (!fallbackCityId) { fallbackCityId = c.id; fallbackProvinceId = c.provinceId; }
  }
  const cityIds = new Set(cities.map(c => c.id));

  // Step 4: Get system user
  const { rows: [admin] } = await newDb.query(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
  const systemUserId = admin?.id;

  // Step 5: Group by company and process
  console.log('=== Step 3: Creating forms ===\n');
  const byCompany = {};
  for (const t of missingTasks) {
    if (!byCompany[t.companyId]) byCompany[t.companyId] = [];
    byCompany[t.companyId].push(t);
  }

  const formsToInsert = [];
  const cplcToInsert = [];
  let matched = 0, unmatched = 0;
  let companiesProcessed = 0;
  const totalCompanies = Object.keys(byCompany).length;

  for (const [companyId, tasks] of Object.entries(byCompany)) {
    companiesProcessed++;
    const oldUserIds = companyOldUsers[companyId] || [];

    let empIndex = {}; // cnic -> employment row

    if (oldUserIds.length > 0) {
      const cnicList = tasks.map(t => t.cnic);
      const { rows: emps } = await oldDb.query(`
        SELECT e.id, e.full_name, e.father_name, e.address, e.city AS employment_city,
          e.cplc_verification_status, e.sindh_police_verification_status,
          e.islamabad_police_verification_status, e.verification_timestamp, e.registration_timestamp,
          w.cnic, w.date_of_birth, w.city_id AS worker_city_id, w.province_id AS worker_province_id,
          w.cnic_front_picture_link, w.cnic_back_picture_link, w.picture_link
        FROM user_worker_employment e JOIN worker w ON w.id = e.worker_id
        WHERE e.user_id = ANY($1::bigint[]) AND e.is_active = true AND w.cnic = ANY($2::text[])
      `, [oldUserIds, cnicList]);

      for (const emp of emps) {
        const c = emp.cnic ? String(emp.cnic).replace(/[^0-9]/g, '') : '';
        empIndex[c] = emp;
      }
    }

    // Also check user_worker_employment_document for image overrides
    const empIds = Object.values(empIndex).map(e => e.id);
    let docMap = {};
    if (empIds.length > 0) {
      const { rows: docs } = await oldDb.query(`
        SELECT DISTINCT ON (d.user_worker_employment_id)
          d.user_worker_employment_id AS eid, d.cnic_front_picture_link, d.cnic_back_picture_link, d.picture_link
        FROM user_worker_employment_document d
        WHERE d.is_active IS DISTINCT FROM false AND d.user_worker_employment_id = ANY($1::bigint[])
        ORDER BY d.user_worker_employment_id, d.id DESC
      `, [empIds]);
      for (const d of docs) docMap[d.eid] = d;
    }

    for (const task of tasks) {
      const emp = empIndex[task.cnic];
      const now = new Date();

      let fullName, fatherName, dob, placeOfBirth, address, cnicFront, cnicBack, facePhoto;
      let result, resultAt, resultNotes, cplcVerdict, cplcStatus;
      let cityId, provinceId;
      const createdAt = task.createdAt || now;

      if (emp) {
        matched++;
        const docs = docMap[emp.id];
        fullName = strOr(emp.full_name, task.worker_name || 'Unknown');
        fatherName = strOr(emp.father_name, 'Unknown');
        dob = emp.date_of_birth || PLACEHOLDER_DOB;
        placeOfBirth = strOr(emp.employment_city, 'Unknown');
        address = strOr(emp.address, 'Unknown');
        cnicFront = normalizeLegacyFileRef(docs?.cnic_front_picture_link) || normalizeLegacyFileRef(emp.cnic_front_picture_link);
        cnicBack = normalizeLegacyFileRef(docs?.cnic_back_picture_link) || normalizeLegacyFileRef(emp.cnic_back_picture_link);
        facePhoto = normalizeLegacyFileRef(docs?.picture_link) || normalizeLegacyFileRef(emp.picture_link);
        result = mapFormResult(emp.cplc_verification_status, emp.sindh_police_verification_status, emp.islamabad_police_verification_status);
        resultAt = result ? (emp.verification_timestamp || createdAt) : null;
        resultNotes = result ? `Migrated from legacy employment #${emp.id}` : null;
        cplcStatus = emp.cplc_verification_status;

        // Resolve city/province
        if (emp.worker_city_id && cityIds.has(emp.worker_city_id)) {
          cityId = emp.worker_city_id;
          provinceId = provinceByCity.get(cityId) || fallbackProvinceId;
        } else if (emp.employment_city) {
          cityId = cityByName.get(emp.employment_city.trim().toLowerCase().replace(/[-\s]+/g, ' '));
          provinceId = cityId ? provinceByCity.get(cityId) : null;
        }
      } else {
        unmatched++;
        fullName = task.worker_name || 'Unknown';
        fatherName = 'Unknown';
        dob = PLACEHOLDER_DOB;
        placeOfBirth = 'Unknown';
        address = 'Unknown';
        result = 'CLEARED';
        resultAt = createdAt;
        resultNotes = 'Migrated — no legacy form data found';
      }

      if (!cityId || !provinceId) {
        cityId = fallbackCityId;
        provinceId = fallbackProvinceId;
      }

      const formId = cuid();
      const cnicNumber = task.cnic || '0000000000000';

      formsToInsert.push([
        formId, task.task_id, fullName, fatherName, dob, placeOfBirth,
        cnicNumber, PLACEHOLDER_CNIC_EXPIRY, cnicFront || null, cnicBack || null,
        facePhoto || null, address, address, cityId, provinceId,
        result, resultNotes, resultAt, createdAt, createdAt,
      ]);

      const verdict = emp ? mapCplcVerdict(cplcStatus) : null;
      if (verdict) {
        cplcToInsert.push([
          cuid(), task.task_id, systemUserId, verdict,
          `Migrated from legacy CPLC status: ${cplcStatus}`,
          emp.verification_timestamp || createdAt, createdAt, createdAt,
        ]);
      }
    }

    if (companiesProcessed % 1000 === 0) console.log(`  Processed ${companiesProcessed}/${totalCompanies} companies...`);
  }

  console.log(`\nForms to create: ${formsToInsert.length} (matched: ${matched}, unmatched: ${unmatched})`);
  console.log(`CPLC reviews to create: ${cplcToInsert.length}\n`);

  if (!DRY_RUN && formsToInsert.length > 0) {
    await newDb.query('BEGIN');
    try {
      const fCols = ['id','"taskId"','"fullName"','"fatherName"','"dateOfBirth"','"placeOfBirth"','"cnicNumber"','"cnicExpiry"','"cnicFrontKey"','"cnicBackKey"','"facePhotoKey"','"currentAddress"','"permanentAddress"','"cityId"','"provinceId"','result','"resultNotes"','"resultAt"','"createdAt"','"updatedAt"'];

      for (let i = 0; i < formsToInsert.length; i += 500) {
        const chunk = formsToInsert.slice(i, i + 500);
        const params = []; const tuples = []; let p = 1;
        for (const v of chunk) { tuples.push(`(${v.map(() => `$${p++}`).join(',')})`); params.push(...v); }
        await newDb.query(`INSERT INTO criminal_verification_forms (${fCols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
        if (i % 5000 === 0) console.log(`  Forms: ${Math.min(i + 500, formsToInsert.length)}/${formsToInsert.length}...`);
      }
      console.log(`Inserted ${formsToInsert.length} forms`);

      if (cplcToInsert.length > 0) {
        const cCols = ['id','"taskId"','"reviewerId"','verdict','notes','"reviewedAt"','"createdAt"','"updatedAt"'];
        for (let i = 0; i < cplcToInsert.length; i += 500) {
          const chunk = cplcToInsert.slice(i, i + 500);
          const params = []; const tuples = []; let p = 1;
          for (const v of chunk) { tuples.push(`(${v.map(() => `$${p++}`).join(',')})`); params.push(...v); }
          await newDb.query(`INSERT INTO cplc_verification_reviews (${cCols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
        }
        console.log(`Inserted ${cplcToInsert.length} CPLC reviews`);
      }

      await newDb.query('COMMIT');
      console.log('\n✓ Committed.');
    } catch (err) {
      await newDb.query('ROLLBACK');
      console.error(`\n✗ ROLLBACK: ${err.message}\n${err.stack}`);
    }
  } else if (DRY_RUN) {
    console.log(`[DRY] Would insert ${formsToInsert.length} forms + ${cplcToInsert.length} CPLC reviews`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Tasks without forms:  ${missingTasks.length}`);
  console.log(`  Forms created:        ${formsToInsert.length}`);
  console.log(`  Matched to old DB:    ${matched}`);
  console.log(`  Unmatched (defaults): ${unmatched}`);
  console.log(`  CPLC reviews:         ${cplcToInsert.length}`);

  await oldDb.end(); await newDb.end();
}

run().catch(e => { console.error(e); process.exit(1); });
