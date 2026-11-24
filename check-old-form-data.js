/**
 * Diagnostic: for DRAFT tasks without forms, check what data exists in the old DB.
 * Matches via worker CNIC.
 *
 * Usage: node check-old-form-data.js
 */
require('dotenv').config();
const { Client } = require('pg');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!NEW_DB_URL || !OLD_DB_URL) { console.error('Set both NEW_DATABASE_URL and OLD_DATABASE_URL in .env'); process.exit(1); }

const SSL = { rejectUnauthorized: false };

// orphan_id → old_user_id (from resolve-results.json migrated email pattern)
const COMPANY_OLD_USERS = {
  'cmwnhyifyc18620bc14f11488': 56137,  // Osama
  'cmwnhyifz23013d9398666cdc': 59103,  // Foodpanda
  'cmwnhyifz630bac7aae6ced6d': 59062,  // Hilal Foods
};

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await newDb.connect();
  await oldDb.connect();

  for (const [companyId, oldUserId] of Object.entries(COMPANY_OLD_USERS)) {
    const { rows: [company] } = await newDb.query(`SELECT name FROM companies WHERE id = $1`, [companyId]);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${company?.name} (old user: ${oldUserId})`);
    console.log('='.repeat(60));

    // Get DRAFT tasks without forms, with worker CNIC
    const { rows: drafts } = await newDb.query(`
      SELECT vt.id AS task_id, w.cnic, w.name AS worker_name, w.id AS worker_id
      FROM verification_tasks vt
      JOIN workers w ON w.id = vt."workerId"
      LEFT JOIN criminal_verification_forms cf ON cf."taskId" = vt.id
      WHERE vt."companyId" = $1 AND vt.status = 'DRAFT' AND cf."taskId" IS NULL
      LIMIT 10
    `, [companyId]);

    console.log(`  Sample DRAFT tasks without forms: ${drafts.length}`);

    let matched = 0, unmatched = 0;
    let hasName = 0, hasFather = 0, hasDob = 0, hasAddress = 0, hasImages = 0;

    for (const d of drafts) {
      if (!d.cnic) { unmatched++; continue; }

      // Find old worker by CNIC
      const { rows: oldWorkers } = await oldDb.query(
        `SELECT id, cnic, date_of_birth, city_id, province_id, picture_link, cnic_front_picture_link, cnic_back_picture_link
         FROM worker WHERE cnic = $1`, [d.cnic]
      );

      if (!oldWorkers.length) { unmatched++; continue; }
      const ow = oldWorkers[0];

      // Find user_worker_employment for this old worker + old user
      const { rows: employments } = await oldDb.query(
        `SELECT uwe.id, uwe.full_name, uwe.father_name, uwe.address,
                uwe.worker_type_id, uwe.cplc_verification_status,
                uwe.sindh_police_verification_status, uwe.islamabad_police_verification_status
         FROM user_worker_employment uwe
         WHERE uwe.worker_id = $1 AND uwe.user_id = $2
         ORDER BY uwe.registration_timestamp DESC LIMIT 1`,
        [ow.id, oldUserId]
      );

      // Find employment documents
      let docs = null;
      if (employments.length) {
        const { rows } = await oldDb.query(
          `SELECT picture_link, cnic_front_picture_link, cnic_back_picture_link
           FROM user_worker_employment_document
           WHERE user_worker_employment_id = $1 LIMIT 1`,
          [employments[0].id]
        );
        docs = rows[0] || null;
      }

      matched++;
      const emp = employments[0];
      if (emp?.full_name) hasName++;
      if (emp?.father_name) hasFather++;
      if (ow.date_of_birth) hasDob++;
      if (emp?.address) hasAddress++;
      if (docs?.picture_link || ow.picture_link) hasImages++;

      if (matched <= 3) {
        console.log(`\n  --- Worker: ${d.worker_name} (CNIC: ${d.cnic}) ---`);
        console.log(`    Old worker id: ${ow.id}`);
        console.log(`    Employment: ${emp ? 'YES' : 'NO'}`);
        if (emp) {
          console.log(`      full_name: ${emp.full_name || '(empty)'}`);
          console.log(`      father_name: ${emp.father_name || '(empty)'}`);
          console.log(`      address: ${emp.address || '(empty)'}`);
          console.log(`      cplc_status: ${emp.cplc_verification_status}`);
          console.log(`      sindh_police: ${emp.sindh_police_verification_status}`);
          console.log(`      islamabad_police: ${emp.islamabad_police_verification_status}`);
        }
        console.log(`    Old worker DOB: ${ow.date_of_birth || '(empty)'}`);
        console.log(`    Old worker city_id: ${ow.city_id}, province_id: ${ow.province_id}`);
        console.log(`    Old worker images: pic=${ow.picture_link ? 'YES' : 'NO'}, front=${ow.cnic_front_picture_link ? 'YES' : 'NO'}, back=${ow.cnic_back_picture_link ? 'YES' : 'NO'}`);
        if (docs) {
          console.log(`    Employment docs: pic=${docs.picture_link ? 'YES' : 'NO'}, front=${docs.cnic_front_picture_link ? 'YES' : 'NO'}, back=${docs.cnic_back_picture_link ? 'YES' : 'NO'}`);
        }
      }
    }

    console.log(`\n  Summary (of ${drafts.length} sampled):`);
    console.log(`    Matched in old DB: ${matched}, Unmatched: ${unmatched}`);
    console.log(`    Has name: ${hasName}, father: ${hasFather}, DOB: ${hasDob}, address: ${hasAddress}, images: ${hasImages}`);
  }

  // Also check: do old city_id/province_id match new DB IDs?
  console.log(`\n${'='.repeat(60)}`);
  console.log('CITY/PROVINCE ID CHECK');
  console.log('='.repeat(60));
  const { rows: oldProvinces } = await oldDb.query(`SELECT id, name FROM province ORDER BY id LIMIT 10`);
  const { rows: newProvinces } = await newDb.query(`SELECT id, name FROM provinces ORDER BY id LIMIT 10`);
  console.log('  Old provinces:', oldProvinces.map(p => `${p.id}:${p.name}`).join(', '));
  console.log('  New provinces:', newProvinces.map(p => `${p.id}:${p.name}`).join(', '));

  const { rows: oldCities } = await oldDb.query(`SELECT id, name FROM city ORDER BY id LIMIT 10`);
  const { rows: newCities } = await newDb.query(`SELECT id, name FROM cities ORDER BY id LIMIT 10`);
  console.log('  Old cities:', oldCities.map(c => `${c.id}:${c.name}`).join(', '));
  console.log('  New cities:', newCities.map(c => `${c.id}:${c.name}`).join(', '));

  await newDb.end();
  await oldDb.end();
}
run().catch(e => { console.error(e); process.exit(1); });
