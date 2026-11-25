/**
 * Fix criminal_verification_forms that have placeholder data
 * by looking up the CNIC directly in the old DB (not via company mapping).
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');
const { normalizeLegacyFileRef } = require('./utils/legacyFiles');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
const NEW_DB_URL = process.env.NEW_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
const BATCH_SIZE = 2000;

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

  // Step 1: Find forms with placeholder data
  console.log('=== Step 1: Finding forms with placeholder data ===\n');
  const { rows: forms } = await newDb.query(`
    SELECT cvf.id, cvf."taskId", cvf."cnicNumber"
    FROM criminal_verification_forms cvf
    WHERE cvf."resultNotes" = 'Migrated — no legacy form data found'
  `);
  console.log(`Forms to fix: ${forms.length}\n`);

  if (forms.length === 0) {
    console.log('Nothing to do.');
    await oldDb.end(); await newDb.end();
    return;
  }

  // Step 2: Build old DB index by CNIC (direct lookup, any user)
  console.log('=== Step 2: Building old DB CNIC index ===\n');

  // Collect unique CNICs
  const uniqueCnics = [...new Set(forms.map(f => f.cnicNumber))];
  console.log(`Unique CNICs to look up: ${uniqueCnics.length}`);

  const cnicIndex = {}; // cnic -> employment data
  const docIndex = {};  // employment_id -> doc data

  for (let i = 0; i < uniqueCnics.length; i += BATCH_SIZE) {
    const batch = uniqueCnics.slice(i, i + BATCH_SIZE);
    const { rows: emps } = await oldDb.query(`
      SELECT DISTINCT ON (w.cnic)
        e.id, e.full_name, e.father_name, e.address, e.city AS employment_city,
        e.cplc_verification_status, e.sindh_police_verification_status,
        e.islamabad_police_verification_status, e.verification_timestamp, e.registration_timestamp,
        w.cnic, w.date_of_birth, w.city_id, w.province_id,
        w.cnic_front_picture_link, w.cnic_back_picture_link, w.picture_link
      FROM user_worker_employment e JOIN worker w ON w.id = e.worker_id
      WHERE w.cnic = ANY($1::text[]) AND e.is_active = true
      ORDER BY w.cnic, e.id DESC
    `, [batch]);

    for (const emp of emps) {
      cnicIndex[emp.cnic] = emp;
    }

    // Load docs for these employments
    const empIds = emps.map(e => e.id);
    if (empIds.length > 0) {
      const { rows: docs } = await oldDb.query(`
        SELECT DISTINCT ON (d.user_worker_employment_id)
          d.user_worker_employment_id AS eid, d.cnic_front_picture_link, d.cnic_back_picture_link, d.picture_link
        FROM user_worker_employment_document d
        WHERE d.is_active IS DISTINCT FROM false AND d.user_worker_employment_id = ANY($1::bigint[])
        ORDER BY d.user_worker_employment_id, d.id DESC
      `, [empIds]);
      for (const d of docs) docIndex[d.eid] = d;
    }

    if (i % 20000 === 0) console.log(`  Loaded ${Math.min(i + BATCH_SIZE, uniqueCnics.length)}/${uniqueCnics.length}...`);
  }

  console.log(`Found old DB data for ${Object.keys(cnicIndex).length} CNICs\n`);

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

  // Step 4: Update forms
  console.log('=== Step 3: Updating forms ===\n');
  let updated = 0, notFound = 0;

  if (!DRY_RUN) {
    await newDb.query('BEGIN');
    try {
      for (let i = 0; i < forms.length; i++) {
        const form = forms[i];
        const emp = cnicIndex[form.cnicNumber];
        if (!emp) { notFound++; continue; }

        const docs = docIndex[emp.id];
        const cnicFront = normalizeLegacyFileRef(docs?.cnic_front_picture_link) || normalizeLegacyFileRef(emp.cnic_front_picture_link);
        const cnicBack = normalizeLegacyFileRef(docs?.cnic_back_picture_link) || normalizeLegacyFileRef(emp.cnic_back_picture_link);
        const facePhoto = normalizeLegacyFileRef(docs?.picture_link) || normalizeLegacyFileRef(emp.picture_link);

        let cityId = null, provinceId = null;
        if (emp.city_id && cityIds.has(emp.city_id)) {
          cityId = emp.city_id;
          provinceId = provinceByCity.get(cityId) || fallbackProvinceId;
        } else if (emp.employment_city) {
          cityId = cityByName.get(emp.employment_city.trim().toLowerCase().replace(/[-\s]+/g, ' '));
          provinceId = cityId ? provinceByCity.get(cityId) : null;
        }
        if (!cityId) { cityId = fallbackCityId; provinceId = fallbackProvinceId; }

        const result = mapFormResult(emp.cplc_verification_status, emp.sindh_police_verification_status, emp.islamabad_police_verification_status);
        const createdAt = emp.verification_timestamp || emp.registration_timestamp || form.createdAt;

        await newDb.query(`
          UPDATE criminal_verification_forms SET
            "fullName" = $2, "fatherName" = $3, "dateOfBirth" = $4, "placeOfBirth" = $5,
            "cnicFrontKey" = $6, "cnicBackKey" = $7, "facePhotoKey" = $8,
            "currentAddress" = $9, "permanentAddress" = $10,
            "cityId" = $11, "provinceId" = $12,
            "result" = $13, "resultNotes" = $14, "resultAt" = $15
          WHERE id = $1
        `, [
          form.id,
          strOr(emp.full_name, 'Unknown'), strOr(emp.father_name, 'Unknown'),
          emp.date_of_birth || PLACEHOLDER_DOB, strOr(emp.employment_city, 'Unknown'),
          cnicFront || null, cnicBack || null, facePhoto || null,
          strOr(emp.address, 'Unknown'), strOr(emp.address, 'Unknown'),
          cityId, provinceId,
          result || 'CLEARED',
          result ? `Migrated from legacy employment #${emp.id}` : `Migrated from legacy employment #${emp.id} (no verification status)`,
          result ? (emp.verification_timestamp || createdAt) : createdAt,
        ]);
        updated++;

        if (updated % 5000 === 0) console.log(`  Updated ${updated}/${forms.length}...`);
      }
      await newDb.query('COMMIT');
      console.log(`\n✓ Committed.`);
    } catch (err) {
      await newDb.query('ROLLBACK');
      console.error(`\n✗ ROLLBACK: ${err.message}\n${err.stack}`);
    }
  } else {
    for (const form of forms) {
      if (cnicIndex[form.cnicNumber]) updated++; else notFound++;
    }
    console.log(`[DRY] Would update ${updated} forms, ${notFound} CNICs not in old DB`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Forms with placeholder data: ${forms.length}`);
  console.log(`  Updated with old DB data:    ${updated}`);
  console.log(`  CNIC not found in old DB:    ${notFound}`);

  await oldDb.end(); await newDb.end();
}

run().catch(e => { console.error(e); process.exit(1); });
