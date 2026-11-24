/**
 * Download legacy image URLs from old sources (old S3 bucket, Cloudinary, old API)
 * and re-upload to the current S3 bucket, updating DB keys.
 *
 * Uses the existing migrateAsset utility which:
 *   - For download-asset URLs: tries tasdeeqimage.s3.us-east-2.amazonaws.com directly
 *   - For Cloudinary URLs: hits them directly
 *   - For other HTTP URLs: fetches directly
 *   - Uploads to S3 via uploadToMinio (works with both MinIO and AWS S3)
 *   - Idempotent via assetMap.json
 *
 * Env vars needed (same as the API):
 *   DATABASE_URL, S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY
 *
 * Usage:
 *   # Probe first — test 10 URLs to see what's accessible
 *   DATABASE_URL="<prod>" node fix-legacy-images.js --prod --probe
 *
 *   # Dry run — count what would be migrated
 *   DATABASE_URL="<prod>" node fix-legacy-images.js --prod --dry-run
 *
 *   # Apply
 *   DATABASE_URL="<prod>" S3_BUCKET=tasdeeq-prod-assets S3_ENDPOINT=https://s3.us-east-2.amazonaws.com S3_REGION=us-east-2 S3_ACCESS_KEY=... S3_SECRET_KEY=... node fix-legacy-images.js --prod --apply
 */

const { Client } = require('pg');

const PROD = process.argv.includes('--prod');
const APPLY = process.argv.includes('--apply');
const PROBE = process.argv.includes('--probe');
const DRY_RUN = !APPLY && !PROBE;

let DB_URL;
if (PROD) {
  DB_URL = process.env.DATABASE_URL;
} else {
  require('dotenv').config();
  DB_URL = 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
}

if (!DB_URL) { console.error('Set DATABASE_URL'); process.exit(1); }

const {
  migrateAsset,
  saveAssetMap,
  isNewMinioKey,
  isOldAssetUrl,
  extractAssetName,
} = require('./utils/migrateAsset');

// Also import download function for probing
const path = require('path');

function isLegacyUrl(val) {
  if (!val) return false;
  const s = String(val).trim();
  if (!s) return false;
  if (isNewMinioKey(s)) return false;
  return /^https?:\/\//i.test(s) || /download-asset/i.test(s);
}

function resolveDownloadUrl(value) {
  const raw = String(value).trim();

  // S3 direct
  const s3Match = raw.match(/^https?:\/\/tasdeeqimage\.s3[^/]*\.amazonaws\.com\/(.+)$/i);
  if (s3Match) return raw.split('?')[0];

  // download-asset → try old S3 bucket directly
  if (/download-asset/i.test(raw) && /asset_name=/i.test(raw)) {
    const nameMatch = raw.match(/[?&]asset_name=([^&]+)/i);
    if (nameMatch) {
      let name;
      try { name = decodeURIComponent(nameMatch[1]); } catch { name = nameMatch[1]; }
      return `https://tasdeeqimage.s3.us-east-2.amazonaws.com/${encodeURIComponent(name)}`;
    }
  }

  return raw;
}

async function probeUrl(url) {
  try {
    const resolved = resolveDownloadUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(resolved, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeout);
    return { url: url.slice(0, 80), resolved: resolved.slice(0, 80), status: resp.status, type: resp.headers.get('content-type') || '-' };
  } catch (e) {
    return { url: url.slice(0, 80), resolved: resolveDownloadUrl(url).slice(0, 80), status: 'FAILED', type: e.message.slice(0, 50) };
  }
}

async function main() {
  const db = new Client({ connectionString: DB_URL, ssl: PROD ? { rejectUnauthorized: false } : false });
  await db.connect();
  console.log(`${PROBE ? '[PROBE] ' : DRY_RUN ? '[DRY RUN] ' : '[APPLY] '}${PROD ? '[PROD] ' : '[LOCAL] '}Connected.\n`);

  // 1. Find all forms with legacy URL image keys
  console.log('Loading forms with legacy URL image keys...');
  const { rows: forms } = await db.query(`
    SELECT cf.id AS form_id,
           cf."cnicFrontKey", cf."cnicBackKey", cf."facePhotoKey"
    FROM criminal_verification_forms cf
    WHERE (cf."cnicFrontKey" ILIKE 'http%' OR cf."cnicFrontKey" ILIKE '%download-asset%')
       OR (cf."cnicBackKey" ILIKE 'http%' OR cf."cnicBackKey" ILIKE '%download-asset%')
       OR (cf."facePhotoKey" ILIKE 'http%' OR cf."facePhotoKey" ILIKE '%download-asset%')
  `);
  console.log(`Forms with legacy URLs: ${forms.length}\n`);

  // Classify URLs by source
  let cloudinaryCount = 0;
  let downloadAssetCount = 0;
  let otherHttpCount = 0;
  const allUrls = new Set();

  for (const f of forms) {
    for (const key of [f.cnicFrontKey, f.cnicBackKey, f.facePhotoKey]) {
      if (!key || !isLegacyUrl(key)) continue;
      allUrls.add(key);
      if (/cloudinary/i.test(key)) cloudinaryCount++;
      else if (/download-asset/i.test(key)) downloadAssetCount++;
      else otherHttpCount++;
    }
  }

  console.log('=== URL BREAKDOWN ===');
  console.log(`Unique legacy URLs: ${allUrls.size}`);
  console.log(`  Cloudinary: ${cloudinaryCount}`);
  console.log(`  download-asset (old API → will try old S3 bucket): ${downloadAssetCount}`);
  console.log(`  Other HTTP: ${otherHttpCount}\n`);

  // === PROBE MODE ===
  if (PROBE) {
    console.log('=== PROBING SAMPLE URLs ===\n');
    const urlArray = [...allUrls];

    // Sample from each category
    const cloudinarySample = urlArray.filter(u => /cloudinary/i.test(u)).slice(0, 5);
    const downloadAssetSample = urlArray.filter(u => /download-asset/i.test(u)).slice(0, 5);
    const otherSample = urlArray.filter(u => !/cloudinary/i.test(u) && !/download-asset/i.test(u)).slice(0, 5);

    console.log('--- Cloudinary ---');
    for (const url of cloudinarySample) {
      const r = await probeUrl(url);
      console.log(`  ${r.status} | ${r.type} | ${r.resolved}`);
    }

    console.log('\n--- download-asset (resolved to old S3 bucket) ---');
    for (const url of downloadAssetSample) {
      const r = await probeUrl(url);
      console.log(`  ${r.status} | ${r.type} | ${r.resolved}`);
    }

    if (otherSample.length > 0) {
      console.log('\n--- Other HTTP ---');
      for (const url of otherSample) {
        const r = await probeUrl(url);
        console.log(`  ${r.status} | ${r.type} | ${r.resolved}`);
      }
    }

    await db.end();
    console.log('\nProbe done. If URLs return 200, run with --apply to migrate them.');
    return;
  }

  // === DRY RUN / APPLY MODE ===
  if (DRY_RUN) {
    console.log('[DRY RUN] Would attempt to download and re-upload all legacy URLs.');
    console.log(`Forms to process: ${forms.length}`);
    console.log(`Unique URLs to download: ${allUrls.size}`);
    console.log('\nRun with --probe first to test accessibility, then --apply to execute.');
    await db.end();
    return;
  }

  // Apply mode
  if (!process.env.S3_BUCKET || !process.env.S3_ACCESS_KEY) {
    console.error('S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY required for --apply');
    process.exit(1);
  }

  console.log('Processing forms...\n');
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let updated = 0;
  const failedUrls = new Map(); // url → error

  const CONCURRENCY = Number(process.env.ASSET_MIGRATE_CONCURRENCY) || 3;
  const SAVE_INTERVAL = 500;

  for (let i = 0; i < forms.length; i++) {
    const f = forms[i];
    const updates = {};
    let hasUpdate = false;

    for (const [col, dbCol] of [['cnicFrontKey', '"cnicFrontKey"'], ['cnicBackKey', '"cnicBackKey"'], ['facePhotoKey', '"facePhotoKey"']]) {
      const val = f[col];
      if (!val || !isLegacyUrl(val)) continue;

      const newKey = await migrateAsset(val, {
        folder: 'worker-documents',
        migration: 'fix-legacy-images',
        oldId: f.form_id,
        table: 'criminal_verification_forms',
      });

      if (newKey && newKey !== val) {
        updates[dbCol] = newKey;
        hasUpdate = true;
        succeeded++;
      } else if (!newKey) {
        failed++;
        if (!failedUrls.has(val)) failedUrls.set(val, 'download failed');
      } else {
        skipped++;
      }
    }

    if (hasUpdate) {
      const sets = [];
      const vals = [];
      let idx = 1;
      for (const [dbCol, newKey] of Object.entries(updates)) {
        sets.push(`${dbCol} = $${idx++}`);
        vals.push(newKey);
      }
      vals.push(f.form_id);
      await db.query(`UPDATE criminal_verification_forms SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
      updated++;
    }

    processed++;
    if (processed % SAVE_INTERVAL === 0) {
      saveAssetMap();
      console.log(`  Processed: ${processed}/${forms.length} | Updated: ${updated} | Failed: ${failed}`);
    }
  }

  saveAssetMap();

  console.log('\n=== RESULTS ===');
  console.log(`Forms processed: ${processed}`);
  console.log(`Forms updated (at least 1 image migrated): ${updated}`);
  console.log(`Individual images succeeded: ${succeeded}`);
  console.log(`Individual images failed: ${failed}`);
  console.log(`Already migrated (skipped): ${skipped}`);

  if (failedUrls.size > 0) {
    console.log(`\nUnique failed URLs: ${failedUrls.size}`);
    console.log('Sample failures (first 20):');
    let count = 0;
    for (const [url] of failedUrls) {
      if (count++ >= 20) break;
      console.log(`  ${url.slice(0, 120)}`);
    }
  }

  // Verify
  const { rows: [after] } = await db.query(`
    SELECT
      SUM(CASE WHEN "cnicFrontKey" ILIKE 'http%' OR "cnicFrontKey" ILIKE '%download-asset%' THEN 1 ELSE 0 END)::int AS legacy_front,
      SUM(CASE WHEN "cnicBackKey" ILIKE 'http%' OR "cnicBackKey" ILIKE '%download-asset%' THEN 1 ELSE 0 END)::int AS legacy_back,
      SUM(CASE WHEN "facePhotoKey" ILIKE 'http%' OR "facePhotoKey" ILIKE '%download-asset%' THEN 1 ELSE 0 END)::int AS legacy_photo
    FROM criminal_verification_forms
  `);
  console.log(`\nRemaining legacy URLs: front=${after.legacy_front} back=${after.legacy_back} photo=${after.legacy_photo}`);

  await db.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
