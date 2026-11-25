/**
 * Migrate images that still have old HTTP URLs to S3.
 * Covers: criminal_verification_forms and worker_documents.
 *
 * Downloads from old URL → uploads to S3 → updates DB key.
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');
const https = require('https');
const http = require('http');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
const NEW_DB_URL = process.env.NEW_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const BATCH_SIZE = 500;

const NEW_BUCKET = process.env.S3_BUCKET || 'tasdeeq-prod-assets';
const NEW_REGION = process.env.S3_REGION || 'us-east-2';
const s3 = process.env.S3_ENDPOINT
  ? new S3Client({
      endpoint: process.env.S3_ENDPOINT, region: NEW_REGION,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin', secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin' },
      forcePathStyle: true,
    })
  : new S3Client({ region: NEW_REGION });

function downloadUrl(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/jpeg' }));
      res.on('error', reject);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function uploadToS3(buffer, contentType) {
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const key = `worker-documents/${randomUUID()}.${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: NEW_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  return key;
}

async function pooled(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = await tasks[i](); } catch (e) { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function migrateOneUrl(url) {
  if (!url || !url.startsWith('http')) return null;
  const data = await downloadUrl(url);
  if (!data || data.buffer.length < 100) return null;
  return await uploadToS3(data.buffer, data.contentType);
}

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
  await newDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}  CONCURRENCY: ${CONCURRENCY}\n`);

  // ── Part 1: criminal_verification_forms with old URLs ──
  console.log('=== Part 1: Forms with old HTTP URLs ===\n');
  const { rows: formsWithUrls } = await newDb.query(`
    SELECT id, "cnicFrontKey", "cnicBackKey", "facePhotoKey"
    FROM criminal_verification_forms
    WHERE "cnicFrontKey" LIKE 'http%' OR "cnicBackKey" LIKE 'http%' OR "facePhotoKey" LIKE 'http%'
  `);
  console.log(`Forms with old URLs: ${formsWithUrls.length}`);

  let formsMigrated = 0, formsImageCount = 0, formsFailed = 0;

  if (!DRY_RUN && formsWithUrls.length > 0) {
    for (let i = 0; i < formsWithUrls.length; i += BATCH_SIZE) {
      const batch = formsWithUrls.slice(i, i + BATCH_SIZE);
      const tasks = batch.map(form => async () => {
        const updates = {};
        for (const col of ['cnicFrontKey', 'cnicBackKey', 'facePhotoKey']) {
          if (form[col] && form[col].startsWith('http')) {
            const newKey = await migrateOneUrl(form[col]);
            if (newKey) updates[col] = newKey;
          }
        }
        return { id: form.id, updates };
      });

      const results = await pooled(tasks, CONCURRENCY);

      for (const r of results) {
        if (!r || Object.keys(r.updates).length === 0) { formsFailed++; continue; }
        formsMigrated++;
        formsImageCount += Object.keys(r.updates).length;
        const setClauses = []; const vals = [r.id]; let p = 2;
        for (const [k, v] of Object.entries(r.updates)) { setClauses.push(`"${k}" = $${p++}`); vals.push(v); }
        await newDb.query(`UPDATE criminal_verification_forms SET ${setClauses.join(', ')} WHERE id = $1`, vals);
      }
      console.log(`  Processed ${Math.min(i + BATCH_SIZE, formsWithUrls.length)}/${formsWithUrls.length} (migrated: ${formsMigrated}, failed: ${formsFailed})`);
    }
  } else {
    console.log(`[DRY] Would migrate images for ${formsWithUrls.length} forms`);
  }

  // ── Part 2: worker_documents with old URLs ──
  console.log('\n=== Part 2: Worker documents with old HTTP URLs ===\n');
  const { rows: docsWithUrls } = await newDb.query(`SELECT id, key FROM worker_documents WHERE key LIKE 'http%'`);
  console.log(`Worker docs with old URLs: ${docsWithUrls.length}`);

  let docsMigrated = 0, docsFailed = 0;

  if (!DRY_RUN && docsWithUrls.length > 0) {
    for (let i = 0; i < docsWithUrls.length; i += BATCH_SIZE) {
      const batch = docsWithUrls.slice(i, i + BATCH_SIZE);
      const tasks = batch.map(doc => async () => {
        const newKey = await migrateOneUrl(doc.key);
        return { id: doc.id, newKey };
      });

      const results = await pooled(tasks, CONCURRENCY);

      for (const r of results) {
        if (!r || !r.newKey) { docsFailed++; continue; }
        docsMigrated++;
        await newDb.query(`UPDATE worker_documents SET key = $1 WHERE id = $2`, [r.newKey, r.id]);
      }
      console.log(`  Processed ${Math.min(i + BATCH_SIZE, docsWithUrls.length)}/${docsWithUrls.length} (migrated: ${docsMigrated}, failed: ${docsFailed})`);
    }
  } else {
    console.log(`[DRY] Would migrate ${docsWithUrls.length} worker document images`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Forms with old URLs:      ${formsWithUrls.length}`);
  console.log(`  Forms migrated:           ${formsMigrated}`);
  console.log(`  Form images uploaded:     ${formsImageCount}`);
  console.log(`  Forms failed:             ${formsFailed}`);
  console.log(`  Worker docs with URLs:    ${docsWithUrls.length}`);
  console.log(`  Worker docs migrated:     ${docsMigrated}`);
  console.log(`  Worker docs failed:       ${docsFailed}`);

  await newDb.end();
}

run().catch(e => { console.error(e); process.exit(1); });
