/**
 * Migrate worker images from old S3 bucket (tasdeeqimage, us-east-2) to new MinIO.
 *
 * For each migrated company's workers:
 * 1. Look up old DB image URLs (worker table + employment_document table)
 * 2. Extract the asset_name (= S3 key in old bucket)
 * 3. Download from old S3
 * 4. Upload to new MinIO with the new key format (folder/uuid.ext)
 * 5. Update criminal_verification_forms with the new keys
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 *
 * Env vars needed:
 *   NEW_DATABASE_URL, OLD_DATABASE_URL
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (for old S3)
 *   S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET (for new MinIO)
 */
require('dotenv').config();
const { Client } = require('pg');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!NEW_DB_URL || !OLD_DB_URL) { console.error('Set both DB URLs in .env'); process.exit(1); }

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = { rejectUnauthorized: false };

// Old S3 (AWS)
const OLD_BUCKET = 'tasdeeqimage';
const OLD_REGION = 'us-east-2';
const oldS3 = new S3Client({ region: OLD_REGION });

// New S3 bucket (production)
const NEW_BUCKET = process.env.S3_BUCKET || 'tasdeeq-prod-assets';
const NEW_REGION = process.env.S3_REGION || 'us-east-2';
const newS3 = process.env.S3_ENDPOINT
  ? new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: NEW_REGION,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
        secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
      },
      forcePathStyle: true,
    })
  : new S3Client({ region: NEW_REGION }); // Uses default AWS credentials

// All migrated companies (same 21 from backfill + HRBS)
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
  const match = url.match(/asset_name=(.+)$/);
  return match ? match[1] : null;
}

async function downloadFromOldS3(key) {
  // Try with key as-is, then with .jpg appended
  for (const tryKey of [key, key + '.jpg']) {
    try {
      const res = await oldS3.send(new GetObjectCommand({ Bucket: OLD_BUCKET, Key: tryKey }));
      const chunks = [];
      for await (const chunk of res.Body) chunks.push(chunk);
      return { buffer: Buffer.concat(chunks), contentType: res.ContentType || 'image/jpeg', key: tryKey };
    } catch (err) {
      if (err.name === 'NoSuchKey') continue;
      throw err;
    }
  }
  return null;
}

async function uploadToNewMinIO(buffer, contentType, folder) {
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const key = `${folder}/${randomUUID()}.${ext}`;
  await newS3.send(new PutObjectCommand({
    Bucket: NEW_BUCKET, Key: key, Body: buffer, ContentType: contentType,
  }));
  return key;
}

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await newDb.connect();
  await oldDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);

  let totalForms = 0, totalPhoto = 0, totalFront = 0, totalBack = 0, totalNotFound = 0, totalAlreadyHave = 0;

  for (const m of MAPPINGS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${m.name} (old user: ${m.old_user_id})`);
    console.log('═'.repeat(60));

    // Get all forms for this company that are missing images
    const { rows: forms } = await newDb.query(`
      SELECT cf.id AS form_id, cf."taskId", cf."cnicNumber",
             cf."cnicFrontKey", cf."cnicBackKey", cf."facePhotoKey",
             w.cnic
      FROM criminal_verification_forms cf
      JOIN verification_tasks vt ON vt.id = cf."taskId"
      JOIN workers w ON w.id = vt."workerId"
      WHERE vt."companyId" = $1
    `, [m.target_id]);

    const needImages = forms.filter(f => !f.cnicFrontKey || !f.cnicBackKey || !f.facePhotoKey);
    console.log(`  Total forms: ${forms.length}, missing images: ${needImages.length}`);
    totalForms += needImages.length;

    if (needImages.length === 0) continue;

    // Build old worker map by CNIC
    const cnics = [...new Set(needImages.map(f => f.cnic).filter(Boolean))];
    const oldImageMap = new Map(); // cnic → { photo, front, back }

    if (cnics.length > 0) {
      // Get old worker IDs
      const { rows: oldWorkers } = await oldDb.query(
        `SELECT id, cnic FROM worker WHERE cnic = ANY($1::text[])`, [cnics]
      );

      // For each old worker, get their employment document images (most detailed)
      for (const ow of oldWorkers) {
        const { rows: docs } = await oldDb.query(`
          SELECT d.picture_link, d.cnic_front_picture_link, d.cnic_back_picture_link
          FROM user_worker_employment uwe
          JOIN user_worker_employment_document d ON d.user_worker_employment_id = uwe.id
          WHERE uwe.worker_id = $1 AND uwe.user_id = $2
          ORDER BY uwe.registration_timestamp DESC LIMIT 1
        `, [ow.id, m.old_user_id]);

        if (docs.length > 0) {
          oldImageMap.set(ow.cnic, {
            photo: extractAssetName(docs[0].picture_link),
            front: extractAssetName(docs[0].cnic_front_picture_link),
            back: extractAssetName(docs[0].cnic_back_picture_link),
          });
        } else {
          // Fall back to worker table images
          const { rows: wImgs } = await oldDb.query(
            `SELECT picture_link, cnic_front_picture_link, cnic_back_picture_link FROM worker WHERE id = $1`,
            [ow.id]
          );
          if (wImgs.length > 0) {
            oldImageMap.set(ow.cnic, {
              photo: extractAssetName(wImgs[0].picture_link),
              front: extractAssetName(wImgs[0].cnic_front_picture_link),
              back: extractAssetName(wImgs[0].cnic_back_picture_link),
            });
          }
        }
      }
    }

    let companyPhoto = 0, companyFront = 0, companyBack = 0, companyNotFound = 0;

    for (const form of needImages) {
      const imgs = oldImageMap.get(form.cnic);
      if (!imgs) { companyNotFound++; continue; }

      const updates = {};

      // Face photo
      if (!form.facePhotoKey && imgs.photo) {
        if (DRY_RUN) { companyPhoto++; }
        else {
          const dl = await downloadFromOldS3(imgs.photo);
          if (dl) {
            const newKey = await uploadToNewMinIO(dl.buffer, dl.contentType, 'face-photos');
            updates.facePhotoKey = newKey;
            companyPhoto++;
          }
        }
      }

      // CNIC front
      if (!form.cnicFrontKey && imgs.front) {
        if (DRY_RUN) { companyFront++; }
        else {
          const dl = await downloadFromOldS3(imgs.front);
          if (dl) {
            const newKey = await uploadToNewMinIO(dl.buffer, dl.contentType, 'cnic-images');
            updates.cnicFrontKey = newKey;
            companyFront++;
          }
        }
      }

      // CNIC back
      if (!form.cnicBackKey && imgs.back) {
        if (DRY_RUN) { companyBack++; }
        else {
          const dl = await downloadFromOldS3(imgs.back);
          if (dl) {
            const newKey = await uploadToNewMinIO(dl.buffer, dl.contentType, 'cnic-images');
            updates.cnicBackKey = newKey;
            companyBack++;
          }
        }
      }

      // Update the form
      if (!DRY_RUN && Object.keys(updates).length > 0) {
        const setClauses = Object.entries(updates).map(([k], i) => `"${k}" = $${i + 2}`);
        const values = Object.values(updates);
        await newDb.query(
          `UPDATE criminal_verification_forms SET ${setClauses.join(', ')} WHERE id = $1`,
          [form.form_id, ...values]
        );
      }
    }

    console.log(`  Photos: ${companyPhoto}, Fronts: ${companyFront}, Backs: ${companyBack}, Not found: ${companyNotFound}`);
    totalPhoto += companyPhoto;
    totalFront += companyFront;
    totalBack += companyBack;
    totalNotFound += companyNotFound;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Forms needing images: ${totalForms}`);
  console.log(`  Photos ${DRY_RUN ? 'to migrate' : 'migrated'}: ${totalPhoto}`);
  console.log(`  CNIC fronts ${DRY_RUN ? 'to migrate' : 'migrated'}: ${totalFront}`);
  console.log(`  CNIC backs ${DRY_RUN ? 'to migrate' : 'migrated'}: ${totalBack}`);
  console.log(`  Not found in old DB: ${totalNotFound}`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  await newDb.end();
  await oldDb.end();
}
run().catch(e => { console.error(e); process.exit(1); });
