/**
 * Check old S3 bucket image key patterns by examining old DB URLs,
 * then list a sample of actual keys from the tasdeeqimage bucket.
 *
 * Usage: node check-s3-images.js
 * Requires: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in env or ~/.aws/credentials
 */
require('dotenv').config();
const { Client } = require('pg');
const { S3Client, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');

const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!OLD_DB_URL) { console.error('Set OLD_DATABASE_URL in .env'); process.exit(1); }
const SSL = { rejectUnauthorized: false };

const OLD_BUCKET = 'tasdeeqimage';
const OLD_REGION = 'us-east-2';

async function run() {
  const db = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await db.connect();

  // 1. Sample image URLs from old DB
  console.log('=== OLD DB IMAGE URL PATTERNS ===\n');

  const { rows: workerSamples } = await db.query(`
    SELECT picture_link, cnic_front_picture_link, cnic_back_picture_link
    FROM worker
    WHERE picture_link IS NOT NULL AND picture_link != ''
    LIMIT 5
  `);
  console.log('Worker table samples:');
  for (const r of workerSamples) {
    console.log(`  photo: ${r.picture_link}`);
    console.log(`  front: ${r.cnic_front_picture_link}`);
    console.log(`  back:  ${r.cnic_back_picture_link}`);
    console.log();
  }

  const { rows: docSamples } = await db.query(`
    SELECT picture_link, cnic_front_picture_link, cnic_back_picture_link
    FROM user_worker_employment_document
    WHERE picture_link IS NOT NULL AND picture_link != ''
    LIMIT 5
  `);
  console.log('Employment document samples:');
  for (const r of docSamples) {
    console.log(`  photo: ${r.picture_link}`);
    console.log(`  front: ${r.cnic_front_picture_link}`);
    console.log(`  back:  ${r.cnic_back_picture_link}`);
    console.log();
  }

  await db.end();

  // 2. List S3 bucket keys
  console.log('=== S3 BUCKET LISTING ===\n');
  const s3 = new S3Client({ region: OLD_REGION });

  try {
    // List top-level prefixes
    const topLevel = await s3.send(new ListObjectsV2Command({
      Bucket: OLD_BUCKET, Delimiter: '/', MaxKeys: 20,
    }));
    console.log('Top-level prefixes:');
    for (const p of (topLevel.CommonPrefixes || [])) {
      console.log(`  ${p.Prefix}`);
    }
    console.log('Top-level objects:');
    for (const o of (topLevel.Contents || []).slice(0, 10)) {
      console.log(`  ${o.Key} (${o.Size} bytes)`);
    }

    // List a few objects overall
    const allObjs = await s3.send(new ListObjectsV2Command({
      Bucket: OLD_BUCKET, MaxKeys: 20,
    }));
    console.log('\nFirst 20 keys:');
    for (const o of (allObjs.Contents || [])) {
      console.log(`  ${o.Key} (${o.Size} bytes, ${o.LastModified})`);
    }
  } catch (err) {
    console.error(`S3 error: ${err.message}`);
  }
}
run().catch(e => { console.error(e); process.exit(1); });
