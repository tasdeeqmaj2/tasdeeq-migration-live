/**
 * Migrate worker images from old S3 bucket (tasdeeqimage, us-east-2) to new S3.
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 * Set CONCURRENCY=N to control parallel S3 transfers (default 10).
 */
require('dotenv').config();
const { Client } = require('pg');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!NEW_DB_URL || !OLD_DB_URL) { console.error('Set both DB URLs in .env'); process.exit(1); }

const DRY_RUN = process.env.DRY_RUN !== 'false';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const SSL = { rejectUnauthorized: false };

const OLD_BUCKET = 'tasdeeqimage';
const OLD_REGION = 'us-east-2';
const oldS3 = new S3Client({ region: OLD_REGION });

const NEW_BUCKET = process.env.S3_BUCKET || 'tasdeeq-prod-assets';
const NEW_REGION = process.env.S3_REGION || 'us-east-2';
const newS3 = process.env.S3_ENDPOINT
  ? new S3Client({
      endpoint: process.env.S3_ENDPOINT, region: NEW_REGION,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin', secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin' },
      forcePathStyle: true,
    })
  : new S3Client({ region: NEW_REGION });

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
  { target_id: 'cmwnhyihg639a0e91da02f2c7', old_user_id: 407063, name: 'HR Business Solutions' },
];

function extractAssetName(url) {
  if (!url) return null;
  const m = url.match(/asset_name=(.+)$/);
  return m ? m[1] : null;
}

async function downloadFromOldS3(key) {
  for (const tryKey of [key, key + '.jpg']) {
    try {
      const res = await oldS3.send(new GetObjectCommand({ Bucket: OLD_BUCKET, Key: tryKey }));
      const chunks = [];
      for await (const chunk of res.Body) chunks.push(chunk);
      return { buffer: Buffer.concat(chunks), contentType: res.ContentType || 'image/jpeg' };
    } catch (err) {
      if (err.name === 'NoSuchKey') continue;
      throw err;
    }
  }
  return null;
}

async function uploadToNewS3(buffer, contentType, folder) {
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const key = `${folder}/${randomUUID()}.${ext}`;
  await newS3.send(new PutObjectCommand({ Bucket: NEW_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  return key;
}

// Run tasks with concurrency limit
async function pooled(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await newDb.connect();
  await oldDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}  CONCURRENCY: ${CONCURRENCY}\n`);

  let totalPhoto = 0, totalFront = 0, totalBack = 0, totalNotFound = 0, totalSkipped = 0;

  for (const m of MAPPINGS) {
    const t0 = Date.now();
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${m.name} (old user: ${m.old_user_id})`);

    // 1. Get all forms missing images — single query
    const { rows: forms } = await newDb.query(`
      SELECT cf.id AS form_id, cf."cnicFrontKey", cf."cnicBackKey", cf."facePhotoKey", w.cnic
      FROM criminal_verification_forms cf
      JOIN verification_tasks vt ON vt.id = cf."taskId"
      JOIN workers w ON w.id = vt."workerId"
      WHERE vt."companyId" = $1
        AND (cf."cnicFrontKey" IS NULL OR cf."cnicBackKey" IS NULL OR cf."facePhotoKey" IS NULL)
    `, [m.target_id]);

    if (forms.length === 0) { console.log(`  No forms missing images. (${Date.now() - t0}ms)`); continue; }

    // 2. Batch fetch old image URLs — two queries total
    const cnics = [...new Set(forms.map(f => f.cnic).filter(Boolean))];
    const oldImageMap = new Map();

    if (cnics.length > 0) {
      // Get old worker IDs in one query
      const { rows: oldWorkers } = await oldDb.query(
        `SELECT id, cnic, picture_link, cnic_front_picture_link, cnic_back_picture_link FROM worker WHERE cnic = ANY($1::text[])`,
        [cnics]
      );
      const workerByCnic = new Map();
      for (const ow of oldWorkers) workerByCnic.set(ow.cnic, ow);

      // Get employment docs in one batch query
      const oldWorkerIds = oldWorkers.map(w => w.id);
      const docMap = new Map();
      if (oldWorkerIds.length > 0) {
        const { rows: docs } = await oldDb.query(`
          SELECT DISTINCT ON (uwe.worker_id)
                 uwe.worker_id,
                 d.picture_link, d.cnic_front_picture_link, d.cnic_back_picture_link
          FROM user_worker_employment uwe
          JOIN user_worker_employment_document d ON d.user_worker_employment_id = uwe.id
          WHERE uwe.worker_id = ANY($1::bigint[]) AND uwe.user_id = $2
          ORDER BY uwe.worker_id, uwe.registration_timestamp DESC
        `, [oldWorkerIds, m.old_user_id]);
        for (const d of docs) docMap.set(String(d.worker_id), d);
      }

      // Build image map: prefer employment doc, fall back to worker table
      for (const ow of oldWorkers) {
        const doc = docMap.get(String(ow.id));
        const src = doc || ow;
        oldImageMap.set(ow.cnic, {
          photo: extractAssetName(src.picture_link),
          front: extractAssetName(src.cnic_front_picture_link),
          back: extractAssetName(src.cnic_back_picture_link),
        });
      }
    }

    console.log(`  Forms missing images: ${forms.length}, matched in old DB: ${oldImageMap.size}/${cnics.length}`);

    // 3. Build transfer tasks
    let companyPhoto = 0, companyFront = 0, companyBack = 0, companyNotFound = 0;

    if (DRY_RUN) {
      for (const form of forms) {
        const imgs = oldImageMap.get(form.cnic);
        if (!imgs) { companyNotFound++; continue; }
        if (!form.facePhotoKey && imgs.photo) companyPhoto++;
        if (!form.cnicFrontKey && imgs.front) companyFront++;
        if (!form.cnicBackKey && imgs.back) companyBack++;
      }
    } else {
      // Build all transfer+update tasks, then run with concurrency
      const tasks = [];
      for (const form of forms) {
        const imgs = oldImageMap.get(form.cnic);
        if (!imgs) { companyNotFound++; continue; }

        tasks.push(async () => {
          const updates = {};
          let p = 0, f = 0, b = 0;

          if (!form.facePhotoKey && imgs.photo) {
            const dl = await downloadFromOldS3(imgs.photo);
            if (dl) { updates.facePhotoKey = await uploadToNewS3(dl.buffer, dl.contentType, 'face-photos'); p = 1; }
          }
          if (!form.cnicFrontKey && imgs.front) {
            const dl = await downloadFromOldS3(imgs.front);
            if (dl) { updates.cnicFrontKey = await uploadToNewS3(dl.buffer, dl.contentType, 'cnic-images'); f = 1; }
          }
          if (!form.cnicBackKey && imgs.back) {
            const dl = await downloadFromOldS3(imgs.back);
            if (dl) { updates.cnicBackKey = await uploadToNewS3(dl.buffer, dl.contentType, 'cnic-images'); b = 1; }
          }

          if (Object.keys(updates).length > 0) {
            const setClauses = Object.entries(updates).map(([k], i) => `"${k}" = $${i + 2}`);
            await newDb.query(
              `UPDATE criminal_verification_forms SET ${setClauses.join(', ')} WHERE id = $1`,
              [form.form_id, ...Object.values(updates)]
            );
          }
          return { p, f, b };
        });
      }

      if (tasks.length > 0) {
        const results = await pooled(tasks, CONCURRENCY);
        for (const r of results) {
          if (r) { companyPhoto += r.p; companyFront += r.f; companyBack += r.b; }
        }
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  Photos: ${companyPhoto}, Fronts: ${companyFront}, Backs: ${companyBack}, Not found: ${companyNotFound} (${elapsed}s)`);
    totalPhoto += companyPhoto;
    totalFront += companyFront;
    totalBack += companyBack;
    totalNotFound += companyNotFound;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Photos ${DRY_RUN ? 'to migrate' : 'migrated'}: ${totalPhoto}`);
  console.log(`  CNIC fronts ${DRY_RUN ? 'to migrate' : 'migrated'}: ${totalFront}`);
  console.log(`  CNIC backs ${DRY_RUN ? 'to migrate' : 'migrated'}: ${totalBack}`);
  console.log(`  Not found in old DB: ${totalNotFound}`);

  await newDb.end();
  await oldDb.end();
}
run().catch(e => { console.error(e); process.exit(1); });
