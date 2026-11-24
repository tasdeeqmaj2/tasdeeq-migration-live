/**
 * Backfill criminal_verification_forms for HR Business Solutions DRAFT tasks.
 * Same pattern as backfill-forms.js but for a single company.
 *
 * Run AFTER migrate-hrbs.js so the workers are under the target company.
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!NEW_DB_URL || !OLD_DB_URL) { console.error('Set both NEW_DATABASE_URL and OLD_DATABASE_URL in .env'); process.exit(1); }

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = { rejectUnauthorized: false };

const TARGET_ID = 'cmwnhyihg639a0e91da02f2c7'; // HR Business Solutions
const OLD_USER_ID = 407063;

const DEFAULT_DOB = '2000-01-01';
const DEFAULT_ADDRESS = 'N/A';
const DEFAULT_CITY_ID = 135;
const DEFAULT_PROVINCE_ID = 7;

function cuid() {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(12).toString('base64url').slice(0, 16).toLowerCase();
  return ('c' + ts + rnd).slice(0, 25);
}

function parseDob(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() > 1900 && d.getFullYear() < 2020) return d.toISOString().split('T')[0];
  return null;
}

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await newDb.connect();
  await oldDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}`);
  console.log(`Target: HR Business Solutions (${TARGET_ID})`);
  console.log(`Old user: ${OLD_USER_ID}\n`);

  // Find tasks without forms
  const { rows: tasks } = await newDb.query(`
    SELECT vt.id AS task_id, vt.status, w.cnic, w.name AS worker_name
    FROM verification_tasks vt
    JOIN workers w ON w.id = vt."workerId"
    LEFT JOIN criminal_verification_forms cf ON cf."taskId" = vt.id
    WHERE vt."companyId" = $1 AND cf."taskId" IS NULL
  `, [TARGET_ID]);

  console.log(`Tasks without forms: ${tasks.length}`);
  if (tasks.length === 0) { console.log('Nothing to do.'); await newDb.end(); await oldDb.end(); return; }

  // Build old worker map by CNIC
  const cnics = [...new Set(tasks.map(t => t.cnic).filter(Boolean))];
  const oldWorkerMap = new Map();

  if (cnics.length > 0) {
    const { rows: oldWorkers } = await oldDb.query(
      `SELECT id, cnic, date_of_birth, city_id, province_id FROM worker WHERE cnic = ANY($1::text[])`,
      [cnics]
    );
    for (const ow of oldWorkers) oldWorkerMap.set(ow.cnic, ow);

    const oldWorkerIds = oldWorkers.map(w => w.id);
    if (oldWorkerIds.length > 0) {
      const { rows: employments } = await oldDb.query(`
        SELECT DISTINCT ON (worker_id)
               id, worker_id, full_name, father_name, address
        FROM user_worker_employment
        WHERE worker_id = ANY($1::bigint[]) AND user_id = $2
        ORDER BY worker_id, registration_timestamp DESC
      `, [oldWorkerIds, OLD_USER_ID]);

      for (const emp of employments) {
        const ow = [...oldWorkerMap.values()].find(w => String(w.id) === String(emp.worker_id));
        if (ow) ow._employment = emp;
      }
    }
  }

  let created = 0, skipped = 0, notFound = 0;

  if (!DRY_RUN) await newDb.query('BEGIN');

  try {
    for (const task of tasks) {
      if (!task.cnic) { skipped++; continue; }

      const ow = oldWorkerMap.get(task.cnic);
      if (!ow || !ow._employment) { notFound++; continue; }

      const emp = ow._employment;
      const dob = parseDob(ow.date_of_birth) || DEFAULT_DOB;
      const cityId = ow.city_id || DEFAULT_CITY_ID;
      const provinceId = ow.province_id || DEFAULT_PROVINCE_ID;

      if (DRY_RUN) {
        created++;
      } else {
        const now = new Date().toISOString();
        await newDb.query(`
          INSERT INTO criminal_verification_forms (
            "id", "taskId", "fullName", "fatherName", "dateOfBirth",
            "cnicNumber", "currentAddress", "cityId", "provinceId",
            "createdAt", "updatedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT ("taskId") DO NOTHING
        `, [
          cuid(), task.task_id,
          emp.full_name || task.worker_name,
          emp.father_name || 'N/A',
          dob, task.cnic,
          emp.address || DEFAULT_ADDRESS,
          cityId, provinceId,
          now, now,
        ]);
        created++;
      }
    }

    if (!DRY_RUN) {
      await newDb.query('COMMIT');
      console.log('✓ Committed');
    }
  } catch (err) {
    if (!DRY_RUN) await newDb.query('ROLLBACK');
    console.error(`✗ ERROR: ${err.message}`);
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] Would create' : '✓ Created'}: ${created} forms`);
  if (skipped) console.log(`Skipped (no CNIC): ${skipped}`);
  if (notFound) console.log(`Not found in old DB: ${notFound}`);

  await newDb.end();
  await oldDb.end();
}
run().catch(e => { console.error(e); process.exit(1); });
