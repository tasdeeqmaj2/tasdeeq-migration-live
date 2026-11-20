/**
 * Recovery script: re-download originals from old `tasdeeqimage` S3 bucket
 * and upload to new `tasdeeq-prod-assets` with the SAME key already in the DB.
 *
 * The asset migration uploaded to old MinIO which was deleted. The originals
 * still exist in the old S3 bucket. This script:
 *   1. Reads all new-style keys from new DB
 *   2. Checks if they exist in the new S3 bucket
 *   3. If missing, looks up the original URL from old DB via ID relationships
 *   4. Downloads from old bucket and uploads to new bucket with the existing key
 *
 * Usage:
 *   node recoverAssets.js                    # full run
 *   RECOVER_TABLE=companies node recoverAssets.js  # just one table
 *   DRY_RUN=1 node recoverAssets.js          # check only, no uploads
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const path = require('path');
const {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');

// ─── Config ──────────────────────────────────────────────────────────────────

const endpoint = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const isAws = endpoint.includes('amazonaws.com');
const s3 = new S3Client({
  ...(isAws ? {} : { endpoint }),
  region: process.env.S3_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
  },
  forcePathStyle: !isAws,
});

const BUCKET = process.env.S3_BUCKET ?? 'tasdeeq';
const CONCURRENCY = Number(process.env.RECOVER_CONCURRENCY) || 20;
const DRY_RUN = process.env.DRY_RUN === '1';
const RECOVER_TABLE = process.env.RECOVER_TABLE || 'all';
const BATCH = 500;

const OLD_S3_BASE = 'https://tasdeeqimage.s3.us-east-2.amazonaws.com';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function keyExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function downloadFromOldBucket(assetName) {
  // Try multiple URL patterns
  const urls = [
    `${OLD_S3_BASE}/${encodeURIComponent(assetName)}`,
    `${OLD_S3_BASE}/${assetName}`,
  ];

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      clearTimeout(timeout);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > 0) return buffer;
      }
    } catch {}
  }
  return null;
}

async function uploadToS3(key, buffer, mimeType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType || 'application/octet-stream',
  }));
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
};

function mimeFromKey(key) {
  const ext = path.extname(key).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function extractAssetName(url) {
  if (!url) return null;
  const raw = String(url).trim();
  if (!raw) return null;
  const match = raw.match(/[?&]asset_name=([^&]+)/i);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return path.basename(u.pathname) || null;
    } catch {
      return path.basename(raw.split('?')[0]) || null;
    }
  }
  return raw;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker()));
  return results;
}

// ─── Recovery: Companies ─────────────────────────────────────────────────────

async function recoverCompanies(oldDb, newDb) {
  console.log('\n=== RECOVERING: companies.logoKey ===');
  const companyMap = loadMap('companyMap.json');
  // Invert: newId → oldId
  const invertedMap = {};
  for (const [oldId, newId] of Object.entries(companyMap)) {
    invertedMap[newId] = oldId;
  }

  const { rows } = await newDb.query(
    `SELECT id, "logoKey" FROM companies
     WHERE "logoKey" IS NOT NULL AND "logoKey" LIKE '%/%' AND "logoKey" NOT LIKE 'http%'`
  );
  console.log(`  Total: ${rows.length}`);

  let recovered = 0, missing = 0, alreadyOk = 0, noSource = 0;

  await mapPool(rows, CONCURRENCY, async (row) => {
    if (await keyExists(row.logoKey)) { alreadyOk++; return; }

    const oldId = invertedMap[row.id];
    if (!oldId) { noSource++; return; }

    // Get original URL from old DB
    const old = await oldDb.query(
      `SELECT organization_picture FROM organization WHERE id = $1`, [Number(oldId)]
    );
    const originalUrl = old.rows[0]?.organization_picture;
    const assetName = extractAssetName(originalUrl);
    if (!assetName) { noSource++; return; }

    if (DRY_RUN) { missing++; return; }

    const buffer = await downloadFromOldBucket(assetName);
    if (!buffer) { missing++; console.log(`  FAIL: ${row.logoKey} (source: ${assetName})`); return; }

    await uploadToS3(row.logoKey, buffer, mimeFromKey(row.logoKey));
    recovered++;
  });

  console.log(`  OK: ${alreadyOk}, Recovered: ${recovered}, Failed: ${missing}, No source: ${noSource}`);
  return recovered;
}

// ─── Recovery: worker_documents ──────────────────────────────────────────────

async function recoverWorkerDocuments(oldDb, newDb) {
  console.log('\n=== RECOVERING: worker_documents ===');

  let recovered = 0, missing = 0, alreadyOk = 0, noSource = 0, checked = 0;
  let lastId = '';

  for (;;) {
    const { rows } = await newDb.query(
      `SELECT wd.id, wd.key, wd."workerId", wd."fileType"
       FROM worker_documents wd
       WHERE wd.id > $1
         AND wd.key IS NOT NULL AND wd.key LIKE '%/%' AND wd.key NOT LIKE 'http%'
       ORDER BY wd.id
       LIMIT $2`,
      [lastId, BATCH]
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    await mapPool(rows, CONCURRENCY, async (row) => {
      checked++;
      if (await keyExists(row.key)) { alreadyOk++; return; }

      // The key folder tells us the doc type:
      // worker-documents/ = could be cnic-front, cnic-back, or photo
      // We need to find the original URL. Query old DB via worker mapping.
      // worker_documents stores workerId → we need old employment ID

      // Try matching through the workerMap (on server)
      // Since we can't easily reverse-map, we'll try a different approach:
      // Query old DB for ALL documents of this worker and try to match by type

      if (DRY_RUN) { missing++; return; }

      // We don't have the old URL for this specific doc, mark as missing
      missing++;
    });

    if (checked % 2000 === 0) {
      console.log(`  Progress: checked=${checked} ok=${alreadyOk} recovered=${recovered} missing=${missing}`);
    }
  }

  console.log(`  Checked: ${checked}, OK: ${alreadyOk}, Recovered: ${recovered}, Failed: ${missing}, No source: ${noSource}`);
  return recovered;
}

// ─── Recovery: criminal_verification_forms (CNIC + face photo) ───────────────

async function recoverForms(oldDb, newDb) {
  console.log('\n=== RECOVERING: criminal_verification_forms (CNIC keys) ===');

  // Load formMap: oldEmploymentId → newFormId
  const formMap = loadMap('criminalFormMap.json');
  // Invert: newFormId → oldEmploymentId
  const invertedFormMap = {};
  for (const [oldId, newId] of Object.entries(formMap)) {
    invertedFormMap[newId] = oldId;
  }

  let recovered = 0, missing = 0, alreadyOk = 0, noSource = 0, checked = 0;
  let lastId = '';

  for (;;) {
    const { rows } = await newDb.query(
      `SELECT id, "cnicFrontKey", "cnicBackKey", "facePhotoKey"
       FROM criminal_verification_forms
       WHERE id > $1
         AND (
           ("cnicFrontKey" IS NOT NULL AND "cnicFrontKey" LIKE '%/%' AND "cnicFrontKey" NOT LIKE 'http%')
           OR ("cnicBackKey" IS NOT NULL AND "cnicBackKey" LIKE '%/%' AND "cnicBackKey" NOT LIKE 'http%')
           OR ("facePhotoKey" IS NOT NULL AND "facePhotoKey" LIKE '%/%' AND "facePhotoKey" NOT LIKE 'http%')
         )
       ORDER BY id
       LIMIT $2`,
      [lastId, BATCH]
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    await mapPool(rows, CONCURRENCY, async (row) => {
      checked++;
      const oldId = invertedFormMap[row.id];

      // Check/recover cnicFrontKey
      if (row.cnicFrontKey && row.cnicFrontKey.includes('/') && !row.cnicFrontKey.startsWith('http')) {
        if (!(await keyExists(row.cnicFrontKey))) {
          if (oldId) {
            const old = await oldDb.query(
              `SELECT d.cnic_front_picture_link
               FROM user_worker_employment_document d
               WHERE d.user_worker_employment_id = $1 AND d.is_active IS DISTINCT FROM false
               ORDER BY d.id DESC LIMIT 1`, [Number(oldId)]
            );
            let originalUrl = old.rows[0]?.cnic_front_picture_link;
            if (!originalUrl) {
              const w = await oldDb.query(
                `SELECT w.cnic_front_picture_link
                 FROM user_worker_employment e
                 INNER JOIN worker w ON w.id = e.worker_id
                 WHERE e.id = $1`, [Number(oldId)]
              );
              originalUrl = w.rows[0]?.cnic_front_picture_link;
            }
            const assetName = extractAssetName(originalUrl);
            if (assetName && !DRY_RUN) {
              const buffer = await downloadFromOldBucket(assetName);
              if (buffer) {
                await uploadToS3(row.cnicFrontKey, buffer, mimeFromKey(row.cnicFrontKey));
                recovered++;
              } else { missing++; }
            } else { missing++; }
          } else { noSource++; }
        } else { alreadyOk++; }
      }

      // Check/recover cnicBackKey
      if (row.cnicBackKey && row.cnicBackKey.includes('/') && !row.cnicBackKey.startsWith('http')) {
        if (!(await keyExists(row.cnicBackKey))) {
          if (oldId) {
            const old = await oldDb.query(
              `SELECT d.cnic_back_picture_link
               FROM user_worker_employment_document d
               WHERE d.user_worker_employment_id = $1 AND d.is_active IS DISTINCT FROM false
               ORDER BY d.id DESC LIMIT 1`, [Number(oldId)]
            );
            let originalUrl = old.rows[0]?.cnic_back_picture_link;
            if (!originalUrl) {
              const w = await oldDb.query(
                `SELECT w.cnic_back_picture_link
                 FROM user_worker_employment e
                 INNER JOIN worker w ON w.id = e.worker_id
                 WHERE e.id = $1`, [Number(oldId)]
              );
              originalUrl = w.rows[0]?.cnic_back_picture_link;
            }
            const assetName = extractAssetName(originalUrl);
            if (assetName && !DRY_RUN) {
              const buffer = await downloadFromOldBucket(assetName);
              if (buffer) {
                await uploadToS3(row.cnicBackKey, buffer, mimeFromKey(row.cnicBackKey));
                recovered++;
              } else { missing++; }
            } else { missing++; }
          } else { noSource++; }
        } else { alreadyOk++; }
      }

      // Check/recover facePhotoKey
      if (row.facePhotoKey && row.facePhotoKey.includes('/') && !row.facePhotoKey.startsWith('http')) {
        if (!(await keyExists(row.facePhotoKey))) {
          if (oldId) {
            const w = await oldDb.query(
              `SELECT w.picture_link
               FROM user_worker_employment e
               INNER JOIN worker w ON w.id = e.worker_id
               WHERE e.id = $1`, [Number(oldId)]
            );
            const originalUrl = w.rows[0]?.picture_link;
            const assetName = extractAssetName(originalUrl);
            if (assetName && !DRY_RUN) {
              const buffer = await downloadFromOldBucket(assetName);
              if (buffer) {
                await uploadToS3(row.facePhotoKey, buffer, mimeFromKey(row.facePhotoKey));
                recovered++;
              } else { missing++; }
            } else { missing++; }
          } else { noSource++; }
        } else { alreadyOk++; }
      }
    });

    if (checked % 1000 === 0) {
      console.log(`  Progress: checked=${checked} ok=${alreadyOk} recovered=${recovered} missing=${missing}`);
    }
  }

  console.log(`  Checked: ${checked}, OK: ${alreadyOk}, Recovered: ${recovered}, Failed: ${missing}, No source: ${noSource}`);
  return recovered;
}

// ─── Recovery: worker_documents (via old DB join) ────────────────────────────

async function recoverWorkerDocsFull(oldDb, newDb) {
  console.log('\n=== RECOVERING: worker_documents (full) ===');

  // Strategy: for each worker_document with a missing S3 key, we find the
  // worker → find old employment ID via workerMap → find original doc URLs
  // in old DB → download → upload with the existing key.

  const workerMap = loadMap('workerMap.json');
  // Invert: newWorkerId → oldEmploymentId
  const workerToOldId = {};
  for (const [oldId, newId] of Object.entries(workerMap)) {
    // Multiple old IDs might map to same worker, keep all
    if (!workerToOldId[newId]) workerToOldId[newId] = [];
    workerToOldId[newId].push(Number(oldId));
  }

  let recovered = 0, missing = 0, alreadyOk = 0, noSource = 0, checked = 0;
  let lastId = '';

  for (;;) {
    const { rows } = await newDb.query(
      `SELECT id, key, "workerId", "fileType"
       FROM worker_documents
       WHERE id > $1
         AND key IS NOT NULL AND key LIKE '%/%' AND key NOT LIKE 'http%'
       ORDER BY id
       LIMIT $2`,
      [lastId, BATCH]
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    await mapPool(rows, CONCURRENCY, async (row) => {
      checked++;
      if (await keyExists(row.key)) { alreadyOk++; return; }

      const oldIds = workerToOldId[row.workerId];
      if (!oldIds || oldIds.length === 0) { noSource++; return; }

      // Determine doc type from fileType or key
      const ft = (row.fileType || '').toLowerCase();
      const isPhoto = ft.includes('photo') || row.key.includes('photo');
      const isCnicFront = ft.includes('cnic-front') || ft.includes('cnic_front');
      const isCnicBack = ft.includes('cnic-back') || ft.includes('cnic_back');

      let originalUrl = null;

      for (const oldId of oldIds) {
        if (originalUrl) break;

        // Try employment documents first
        const docs = await oldDb.query(
          `SELECT cnic_front_picture_link, cnic_back_picture_link, picture_link
           FROM user_worker_employment_document
           WHERE user_worker_employment_id = $1 AND is_active IS DISTINCT FROM false
           ORDER BY id DESC LIMIT 1`, [oldId]
        );
        if (docs.rows[0]) {
          if (isCnicFront) originalUrl = docs.rows[0].cnic_front_picture_link;
          else if (isCnicBack) originalUrl = docs.rows[0].cnic_back_picture_link;
          else if (isPhoto) originalUrl = docs.rows[0].picture_link;
        }

        if (!originalUrl) {
          // Try worker table directly
          const w = await oldDb.query(
            `SELECT w.picture_link, w.cnic_front_picture_link, w.cnic_back_picture_link
             FROM user_worker_employment e
             INNER JOIN worker w ON w.id = e.worker_id
             WHERE e.id = $1`, [oldId]
          );
          if (w.rows[0]) {
            if (isCnicFront) originalUrl = w.rows[0].cnic_front_picture_link;
            else if (isCnicBack) originalUrl = w.rows[0].cnic_back_picture_link;
            else if (isPhoto) originalUrl = w.rows[0].picture_link;
            // If type unknown, try all
            if (!originalUrl) {
              originalUrl = w.rows[0].picture_link || w.rows[0].cnic_front_picture_link || w.rows[0].cnic_back_picture_link;
            }
          }
        }
      }

      const assetName = extractAssetName(originalUrl);
      if (!assetName) { noSource++; return; }
      if (DRY_RUN) { missing++; return; }

      const buffer = await downloadFromOldBucket(assetName);
      if (buffer) {
        await uploadToS3(row.key, buffer, mimeFromKey(row.key));
        recovered++;
      } else {
        missing++;
      }
    });

    if (checked % 2000 === 0) {
      console.log(`  Progress: checked=${checked} ok=${alreadyOk} recovered=${recovered} missing=${missing} noSource=${noSource}`);
    }
  }

  console.log(`  Checked: ${checked}, OK: ${alreadyOk}, Recovered: ${recovered}, Failed: ${missing}, No source: ${noSource}`);
  return recovered;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Recovery script — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Target bucket: ${BUCKET}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Table: ${RECOVER_TABLE}`);

  const oldDb = getOldDb();
  const newDb = getNewDb();
  await oldDb.query('SELECT 1');
  await newDb.query('SELECT 1');
  console.log('Connected to both databases.');

  let totalRecovered = 0;

  if (RECOVER_TABLE === 'all' || RECOVER_TABLE === 'companies') {
    totalRecovered += await recoverCompanies(oldDb, newDb);
  }

  if (RECOVER_TABLE === 'all' || RECOVER_TABLE === 'forms') {
    totalRecovered += await recoverForms(oldDb, newDb);
  }

  if (RECOVER_TABLE === 'all' || RECOVER_TABLE === 'documents') {
    totalRecovered += await recoverWorkerDocsFull(oldDb, newDb);
  }

  console.log(`\n=== DONE === Total recovered: ${totalRecovered}`);
}

main()
  .catch((err) => { console.error('\nRecovery failed:', err); process.exitCode = 1; })
  .finally(async () => {
    await closeOldDb().catch(() => {});
    await closeNewDb().catch(() => {});
  });
