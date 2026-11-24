/**
 * Diagnostic: check what image URLs exist in the old DB and if they're accessible.
 * Usage: node check-old-images.js
 */
require('dotenv').config();
const { Client } = require('pg');

const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!OLD_DB_URL) { console.error('Set OLD_DATABASE_URL in .env'); process.exit(1); }
const SSL = { rejectUnauthorized: false };

async function run() {
  const db = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await db.connect();

  // 1. Check worker table images
  console.log('=== WORKER TABLE IMAGES ===');
  const { rows: [wStats] } = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN picture_link IS NOT NULL AND picture_link != '' THEN 1 ELSE 0 END)::int AS has_photo,
      SUM(CASE WHEN cnic_front_picture_link IS NOT NULL AND cnic_front_picture_link != '' THEN 1 ELSE 0 END)::int AS has_front,
      SUM(CASE WHEN cnic_back_picture_link IS NOT NULL AND cnic_back_picture_link != '' THEN 1 ELSE 0 END)::int AS has_back
    FROM worker
  `);
  console.log(`  Total workers: ${wStats.total}`);
  console.log(`  Has photo: ${wStats.has_photo}, front: ${wStats.has_front}, back: ${wStats.has_back}`);

  // Sample URLs
  const { rows: sampleWorkerImages } = await db.query(`
    SELECT picture_link, cnic_front_picture_link, cnic_back_picture_link
    FROM worker
    WHERE picture_link IS NOT NULL AND picture_link != ''
    LIMIT 3
  `);
  console.log('  Sample worker image URLs:');
  for (const r of sampleWorkerImages) {
    console.log(`    photo: ${r.picture_link}`);
    console.log(`    front: ${r.cnic_front_picture_link}`);
    console.log(`    back:  ${r.cnic_back_picture_link}`);
    console.log();
  }

  // 2. Check user_worker_employment_document images
  console.log('=== EMPLOYMENT DOCUMENT IMAGES ===');
  const { rows: [dStats] } = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN picture_link IS NOT NULL AND picture_link != '' THEN 1 ELSE 0 END)::int AS has_photo,
      SUM(CASE WHEN cnic_front_picture_link IS NOT NULL AND cnic_front_picture_link != '' THEN 1 ELSE 0 END)::int AS has_front,
      SUM(CASE WHEN cnic_back_picture_link IS NOT NULL AND cnic_back_picture_link != '' THEN 1 ELSE 0 END)::int AS has_back
    FROM user_worker_employment_document
  `);
  console.log(`  Total docs: ${dStats.total}`);
  console.log(`  Has photo: ${dStats.has_photo}, front: ${dStats.has_front}, back: ${dStats.has_back}`);

  const { rows: sampleDocImages } = await db.query(`
    SELECT picture_link, cnic_front_picture_link, cnic_back_picture_link
    FROM user_worker_employment_document
    WHERE picture_link IS NOT NULL AND picture_link != ''
    LIMIT 3
  `);
  console.log('  Sample employment doc image URLs:');
  for (const r of sampleDocImages) {
    console.log(`    photo: ${r.picture_link}`);
    console.log(`    front: ${r.cnic_front_picture_link}`);
    console.log(`    back:  ${r.cnic_back_picture_link}`);
    console.log();
  }

  // 3. Check temp_worker_pictures
  console.log('=== TEMP WORKER PICTURES ===');
  const { rows: [tStats] } = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN picture_link IS NOT NULL AND picture_link != '' THEN 1 ELSE 0 END)::int AS has_photo,
      SUM(CASE WHEN cnic_front_picture_link IS NOT NULL AND cnic_front_picture_link != '' THEN 1 ELSE 0 END)::int AS has_front,
      SUM(CASE WHEN cnic_back_picture_link IS NOT NULL AND cnic_back_picture_link != '' THEN 1 ELSE 0 END)::int AS has_back
    FROM temp_worker_pictures
  `);
  console.log(`  Total: ${tStats.total}`);
  console.log(`  Has photo: ${tStats.has_photo}, front: ${tStats.has_front}, back: ${tStats.has_back}`);

  const { rows: sampleTemp } = await db.query(`
    SELECT cnic, picture_link, cnic_front_picture_link, cnic_back_picture_link
    FROM temp_worker_pictures
    WHERE picture_link IS NOT NULL AND picture_link != ''
    LIMIT 3
  `);
  console.log('  Sample:');
  for (const r of sampleTemp) {
    console.log(`    cnic: ${r.cnic}`);
    console.log(`    photo: ${r.picture_link}`);
    console.log(`    front: ${r.cnic_front_picture_link}`);
    console.log(`    back:  ${r.cnic_back_picture_link}`);
    console.log();
  }

  // 4. For the migrated companies specifically — how many workers have images?
  console.log('=== MIGRATED COMPANY WORKERS WITH IMAGES (Osama, old user 56137) ===');
  const { rows: [mStats] } = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN d.picture_link IS NOT NULL AND d.picture_link != '' THEN 1 ELSE 0 END)::int AS has_photo,
      SUM(CASE WHEN d.cnic_front_picture_link IS NOT NULL AND d.cnic_front_picture_link != '' THEN 1 ELSE 0 END)::int AS has_front,
      SUM(CASE WHEN d.cnic_back_picture_link IS NOT NULL AND d.cnic_back_picture_link != '' THEN 1 ELSE 0 END)::int AS has_back
    FROM user_worker_employment uwe
    LEFT JOIN user_worker_employment_document d ON d.user_worker_employment_id = uwe.id
    WHERE uwe.user_id = 56137
  `);
  console.log(`  Employments: ${mStats.total}`);
  console.log(`  Has photo: ${mStats.has_photo}, front: ${mStats.has_front}, back: ${mStats.has_back}`);

  // Try to fetch one image to see if the URL is accessible
  if (sampleDocImages.length > 0 && sampleDocImages[0].picture_link) {
    const url = sampleDocImages[0].picture_link;
    console.log(`\n=== TESTING IMAGE URL ACCESS ===`);
    console.log(`  URL: ${url}`);
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      console.log(`  Status: ${res.status} ${res.statusText}`);
      console.log(`  Content-Type: ${res.headers.get('content-type')}`);
      console.log(`  Content-Length: ${res.headers.get('content-length')}`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  await db.end();
}
run().catch(e => { console.error(e); process.exit(1); });
