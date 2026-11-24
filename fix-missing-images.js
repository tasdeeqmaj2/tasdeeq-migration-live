/**
 * Fix missing images on criminal_verification_forms by matching CNIC
 * between new DB workers and old DB worker/employment records.
 *
 * No maps needed — matches by CNIC directly.
 *
 * Usage:
 *   DATABASE_URL="<new>" OLD_DATABASE_URL="<old>" node fix-missing-images.js --prod --dry-run
 *   DATABASE_URL="<new>" OLD_DATABASE_URL="<old>" node fix-missing-images.js --prod
 */

const { Client } = require('pg');

const PROD = process.argv.includes('--prod');
const DRY_RUN = process.argv.includes('--dry-run');

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

const { decryptLegacy } = require('./utils/decrypt');

function normalizeLegacyFileRef(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return s;
}

function decryptCnic(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  return decryptLegacy(s);
}

async function main() {
  const newDb = new Client({ connectionString: NEW_URL, ssl: PROD ? { rejectUnauthorized: false } : false });
  const oldDb = new Client({ connectionString: OLD_URL, ssl: PROD ? { rejectUnauthorized: false } : false });
  await newDb.connect();
  await oldDb.connect();
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${PROD ? '[PROD] ' : '[LOCAL] '}Connected.\n`);

  // 1. Get all forms with missing images from new DB
  console.log('Loading forms with missing images...');
  const { rows: forms } = await newDb.query(`
    SELECT cf.id AS form_id, cf."taskId", cf."cnicFrontKey", cf."cnicBackKey", cf."facePhotoKey",
           w.cnic, w.name AS worker_name
    FROM criminal_verification_forms cf
    JOIN verification_tasks vt ON vt.id = cf."taskId"
    JOIN workers w ON w.id = vt."workerId"
    WHERE (cf."cnicFrontKey" IS NULL OR cf."cnicFrontKey" = '')
       OR (cf."cnicBackKey" IS NULL OR cf."cnicBackKey" = '')
       OR (cf."facePhotoKey" IS NULL OR cf."facePhotoKey" = '')
  `);
  console.log(`Forms with missing images: ${forms.length}\n`);

  // 2. Build a lookup of unique CNICs we need
  const cnicSet = new Set();
  for (const f of forms) {
    if (f.cnic) cnicSet.add(f.cnic);
  }
  console.log(`Unique CNICs to look up: ${cnicSet.size}`);

  // 3. Load old DB images by CNIC
  // First from user_worker_employment_document (most recent per employment)
  // Then from worker table as fallback
  // Load old DB images in two fast queries (no LATERAL)
  const oldImgMap = new Map();

  function addToMap(cnicRaw, front, back, photo) {
    const rawCnic = decryptCnic(cnicRaw);
    if (!rawCnic) return;
    const cnic = rawCnic.replace(/[-\s]/g, '');
    if (!cnic || cnic.length < 10) return;
    const f = normalizeLegacyFileRef(front);
    const b = normalizeLegacyFileRef(back);
    const p = normalizeLegacyFileRef(photo);
    if (!f && !b && !p) return;
    if (!oldImgMap.has(cnic)) {
      oldImgMap.set(cnic, { front: f, back: b, photo: p });
    } else {
      const ex = oldImgMap.get(cnic);
      if (!ex.front && f) ex.front = f;
      if (!ex.back && b) ex.back = b;
      if (!ex.photo && p) ex.photo = p;
    }
  }

  // Query 1: worker table (base images)
  console.log('Loading old DB worker images...');
  const { rows: oldWorkers } = await oldDb.query(`
    SELECT cnic, cnic_front_picture_link, cnic_back_picture_link, picture_link
    FROM worker
    WHERE cnic IS NOT NULL AND cnic != ''
  `);
  console.log(`Old workers loaded: ${oldWorkers.length}`);
  for (const r of oldWorkers) {
    addToMap(r.cnic, r.cnic_front_picture_link, r.cnic_back_picture_link, r.picture_link);
  }

  // Query 2: employment documents (override with newer images)
  console.log('Loading old DB employment documents...');
  const { rows: oldDocs } = await oldDb.query(`
    SELECT w.cnic,
           d.cnic_front_picture_link, d.cnic_back_picture_link, d.picture_link
    FROM user_worker_employment_document d
    JOIN user_worker_employment e ON e.id = d.user_worker_employment_id
    JOIN worker w ON w.id = e.worker_id
    WHERE d.is_active IS DISTINCT FROM false
      AND w.cnic IS NOT NULL AND w.cnic != ''
    ORDER BY d.id DESC
  `);
  console.log(`Old documents loaded: ${oldDocs.length}`);
  for (const r of oldDocs) {
    addToMap(r.cnic, r.cnic_front_picture_link, r.cnic_back_picture_link, r.picture_link);
  }

  console.log(`Old DB unique CNICs with images: ${oldImgMap.size}\n`);

  // 4. Match and prepare updates
  let matched = 0;
  let noMatch = 0;
  let noImages = 0;
  let updatedFront = 0;
  let updatedBack = 0;
  let updatedPhoto = 0;
  let skippedAlreadyHas = 0;

  const updates = []; // { formId, front?, back?, photo? }

  for (const f of forms) {
    if (!f.cnic) { noMatch++; continue; }

    const normalizedCnic = f.cnic.replace(/[-\s]/g, '');
    const old = oldImgMap.get(normalizedCnic);
    if (!old) { noMatch++; continue; }

    const update = { formId: f.form_id };
    let hasUpdate = false;

    if ((!f.cnicFrontKey || f.cnicFrontKey === '') && old.front) {
      update.front = old.front;
      updatedFront++;
      hasUpdate = true;
    }
    if ((!f.cnicBackKey || f.cnicBackKey === '') && old.back) {
      update.back = old.back;
      updatedBack++;
      hasUpdate = true;
    }
    if ((!f.facePhotoKey || f.facePhotoKey === '') && old.photo) {
      update.photo = old.photo;
      updatedPhoto++;
      hasUpdate = true;
    }

    if (hasUpdate) {
      matched++;
      updates.push(update);
    } else {
      noImages++;
    }
  }

  console.log('=== SUMMARY ===');
  console.log(`Forms with missing images: ${forms.length}`);
  console.log(`Matched to old DB images: ${matched}`);
  console.log(`No CNIC match in old DB: ${noMatch}`);
  console.log(`Match found but old has no images either: ${noImages}`);
  console.log(`CNIC front to restore: ${updatedFront}`);
  console.log(`CNIC back to restore: ${updatedBack}`);
  console.log(`Face photo to restore: ${updatedPhoto}`);

  // Show samples
  if (updates.length > 0) {
    console.log('\nSample updates (first 10):');
    for (const u of updates.slice(0, 10)) {
      const f = forms.find(f => f.form_id === u.formId);
      console.log(`  ${f?.worker_name} (${f?.cnic}): front=${u.front ? 'YES' : '-'} back=${u.back ? 'YES' : '-'} photo=${u.photo ? 'YES' : '-'}`);
    }
  }

  // 5. Apply updates
  if (!DRY_RUN && updates.length > 0) {
    console.log(`\nApplying ${updates.length} updates...`);
    let applied = 0;

    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      const sets = [];
      const vals = [];
      let idx = 1;

      if (u.front) { sets.push(`"cnicFrontKey" = $${idx++}`); vals.push(u.front); }
      if (u.back) { sets.push(`"cnicBackKey" = $${idx++}`); vals.push(u.back); }
      if (u.photo) { sets.push(`"facePhotoKey" = $${idx++}`); vals.push(u.photo); }
      vals.push(u.formId);

      await newDb.query(
        `UPDATE criminal_verification_forms SET ${sets.join(', ')} WHERE id = $${idx}`,
        vals
      );
      applied++;

      if (applied % 1000 === 0) {
        console.log(`  Updated ${applied} / ${updates.length}`);
      }
    }
    console.log(`  Updated ${applied} forms total.`);

    // Verify
    const { rows: [after] } = await newDb.query(`
      SELECT
        SUM(CASE WHEN "cnicFrontKey" IS NULL OR "cnicFrontKey" = '' THEN 1 ELSE 0 END)::int AS no_front,
        SUM(CASE WHEN "cnicBackKey" IS NULL OR "cnicBackKey" = '' THEN 1 ELSE 0 END)::int AS no_back,
        SUM(CASE WHEN "facePhotoKey" IS NULL OR "facePhotoKey" = '' THEN 1 ELSE 0 END)::int AS no_photo
      FROM criminal_verification_forms
    `);
    console.log(`\nAfter fix — still missing: front=${after.no_front}, back=${after.no_back}, photo=${after.no_photo}`);
  }

  await newDb.end();
  await oldDb.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
