/**
 * Backfill criminal_verification_forms for DRAFT tasks that are missing them.
 * Pulls data from the OLD DB (user_worker_employment + worker tables).
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 *
 * Usage: node backfill-forms.js
 *        DRY_RUN=false node backfill-forms.js
 */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!NEW_DB_URL || !OLD_DB_URL) { console.error('Set both NEW_DATABASE_URL and OLD_DATABASE_URL in .env'); process.exit(1); }

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = { rejectUnauthorized: false };

// Generate a cuid-like id (Prisma cuid() format: starts with 'c', 25 chars)
function cuid() {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(12).toString('base64url').slice(0, 16).toLowerCase();
  return ('c' + ts + rnd).slice(0, 25);
}

// target_company_id → old_user_id (extracted from migrated email pattern)
const MAPPINGS = [
  { target_id: 'cmwnhyifyc18620bc14f11488', old_user_id: 56137, name: 'Osama Moin' },
  { target_id: 'cmwnhyifz23013d9398666cdc', old_user_id: 59103, name: 'Foodpanda' },
  { target_id: 'cmwnhyifz630bac7aae6ced6d', old_user_id: 59062, name: 'Hilal Foods' },
  { target_id: 'cmwnhyifz384c3166db500859', old_user_id: 59493, name: 'Lucky Cement' },
  { target_id: 'cmwnhyifz7da948695d46afa1', old_user_id: 60136, name: 'Naval Anchorage' },
  { target_id: 'cmwnhyifz970f97cb76b9fb9d', old_user_id: 58855, name: 'Anis Apparel' },
  { target_id: 'cmwnhyify53e0dbcd019982db', old_user_id: 53253, name: 'Pasha & co' },
  { target_id: 'cmwnhyifzd1a2c09f1de29f07', old_user_id: 56996, name: 'Cool Man & Co' },
  { target_id: 'cmwnhyifzb0104bea7bb14189', old_user_id: 65943, name: 'Orchards Cottage' },
  { target_id: 'cmwnhyifzd0259e054a16affb', old_user_id: 63157, name: 'Essa Lab' },
  { target_id: 'cmwnhyifz918fb202e77f99bc', old_user_id: 60240, name: 'Keenan OOne' },
  { target_id: 'cmwnhyifze3cb8d923569553a', old_user_id: 57208, name: 'Pakistan Cotton Nappies' },
  { target_id: 'cmwnhyifz7ebacaab4b36f5a3', old_user_id: 56235, name: 'Janjua & Company' },
  { target_id: 'cmwnhyifz578067c4af5e6a11', old_user_id: 64485, name: 'Sarimad Security' },
  { target_id: 'cmwnhyifx6009fc70499ab1dd', old_user_id: 44277, name: 'EFU Life' },
  { target_id: 'cmwnhyifz1e1e6ab535d34d4a', old_user_id: 57027, name: 'Shahid Afridi Foundation' },
  { target_id: 'cmwnhyifz9b0c2e3266f08d09', old_user_id: 63967, name: 'Griffin Security' },
  { target_id: 'cmwnhyifzeeac27d5a77a95cd', old_user_id: 65364, name: 'Essa Engineering' },
  { target_id: 'cmwnhyifz91255ef97a471c99', old_user_id: 56327, name: 'TAALEM' },
  { target_id: 'cmwnhyifx388fadd28acc0785', old_user_id: 44250, name: 'Tasdeeq (Pvt) Ltd' },
  { target_id: 'cmwnhyify5f82b1e45c08fc43', old_user_id: 54813, name: 'Century Insurance' },
];

// Fallback defaults for required fields when old data is missing
const DEFAULT_DOB = '2000-01-01';
const DEFAULT_ADDRESS = 'N/A';
const DEFAULT_CITY_ID = 135;    // Karachi (most common in old data)
const DEFAULT_PROVINCE_ID = 7;  // Sindh

function parseDob(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() > 1900 && d.getFullYear() < 2020) {
    return d.toISOString().split('T')[0];
  }
  return null;
}

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await newDb.connect();
  await oldDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '🚀 LIVE — WRITING TO DATABASE'}\n`);

  const report = [];
  let totalCreated = 0, totalSkipped = 0, totalNotFound = 0;

  for (const m of MAPPINGS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${m.name} (target: ${m.target_id}, old user: ${m.old_user_id})`);
    console.log('═'.repeat(60));

    // Find all tasks without forms in this company
    const { rows: tasks } = await newDb.query(`
      SELECT vt.id AS task_id, vt.status, w.cnic, w.name AS worker_name, w.id AS worker_id
      FROM verification_tasks vt
      JOIN workers w ON w.id = vt."workerId"
      LEFT JOIN criminal_verification_forms cf ON cf."taskId" = vt.id
      WHERE vt."companyId" = $1 AND cf."taskId" IS NULL
    `, [m.target_id]);

    console.log(`  Tasks without forms: ${tasks.length}`);
    if (tasks.length === 0) {
      report.push({ name: m.name, total: 0, created: 0, skipped: 0, not_found: 0 });
      continue;
    }

    // Build old worker map by CNIC
    const cnics = [...new Set(tasks.map(t => t.cnic).filter(Boolean))];
    const oldWorkerMap = new Map();

    if (cnics.length > 0) {
      const { rows: oldWorkers } = await oldDb.query(`
        SELECT id, cnic, date_of_birth, city_id, province_id
        FROM worker WHERE cnic = ANY($1::text[])
      `, [cnics]);

      for (const ow of oldWorkers) oldWorkerMap.set(ow.cnic, ow);

      const oldWorkerIds = oldWorkers.map(w => w.id);
      if (oldWorkerIds.length > 0) {
        const { rows: employments } = await oldDb.query(`
          SELECT DISTINCT ON (worker_id)
                 id, worker_id, full_name, father_name, address
          FROM user_worker_employment
          WHERE worker_id = ANY($1::bigint[]) AND user_id = $2
          ORDER BY worker_id, registration_timestamp DESC
        `, [oldWorkerIds, m.old_user_id]);

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
        const id = cuid();

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
            id,
            task.task_id,
            emp.full_name || task.worker_name,
            emp.father_name || 'N/A',
            dob,
            task.cnic,
            emp.address || DEFAULT_ADDRESS,
            cityId,
            provinceId,
            now,
            now,
          ]);
          created++;
        }
      }

      if (!DRY_RUN) {
        await newDb.query('COMMIT');
        console.log(`  ✓ Committed`);
      }
    } catch (err) {
      if (!DRY_RUN) await newDb.query('ROLLBACK');
      console.error(`  ✗ ERROR: ${err.message}`);
    }

    console.log(`  ${DRY_RUN ? '[DRY RUN] Would create' : '✓ Created'}: ${created} forms`);
    if (skipped) console.log(`  Skipped (no CNIC): ${skipped}`);
    if (notFound) console.log(`  Not found in old DB: ${notFound}`);
    totalCreated += created;
    totalSkipped += skipped;
    totalNotFound += notFound;
    report.push({ name: m.name, total: tasks.length, created, skipped, not_found: notFound });
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Total forms ${DRY_RUN ? 'to create' : 'created'}: ${totalCreated}`);
  console.log(`  Skipped (no CNIC): ${totalSkipped}`);
  console.log(`  Not found in old DB: ${totalNotFound}`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const outPath = __dirname + '/backfill-forms-report.json';
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`  Report: ${outPath}`);

  await newDb.end();
  await oldDb.end();
}
run().catch(e => { console.error(e); process.exit(1); });
