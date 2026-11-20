/**
 * Verify which DB keys actually exist in S3.
 * Reports missing keys so we know what needs recovery.
 *
 * Usage: node verifyS3Keys.js
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getNewDb, closeNewDb } = require('./db/newDb');

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
const CONCURRENCY = Number(process.env.VERIFY_CONCURRENCY) || 50;

async function keyExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function checkTable(db, label, query) {
  console.log(`\n--- ${label} ---`);
  const { rows } = await db.query(query);
  console.log(`  Total keys to check: ${rows.length}`);

  if (rows.length === 0) return { missing: 0, total: 0, missingKeys: [] };

  let checked = 0;
  let missing = 0;
  const missingKeys = [];

  await mapPool(rows, CONCURRENCY, async (row) => {
    const exists = await keyExists(row.key);
    checked++;
    if (!exists) {
      missing++;
      missingKeys.push({ id: row.id, key: row.key });
    }
    if (checked % 1000 === 0) {
      console.log(`  checked ${checked}/${rows.length}, missing so far: ${missing}`);
    }
  });

  console.log(`  Result: ${missing} missing out of ${rows.length}`);
  return { missing, total: rows.length, missingKeys };
}

async function main() {
  const db = getNewDb();
  await db.query('SELECT 1');
  console.log(`Bucket: ${BUCKET}`);
  console.log(`Concurrency: ${CONCURRENCY}`);

  // Sample first — check 500 from each table to get a sense of how many are missing
  const sampleSize = Number(process.env.VERIFY_SAMPLE) || 0;
  const limitClause = sampleSize > 0 ? `LIMIT ${sampleSize}` : '';

  const docs = await checkTable(db, 'worker_documents',
    `SELECT id, key FROM worker_documents
     WHERE key IS NOT NULL AND key LIKE '%/%' AND key NOT LIKE 'http%'
     ORDER BY id ${limitClause}`);

  const cnicFront = await checkTable(db, 'criminal_verification_forms (cnicFrontKey)',
    `SELECT id, "cnicFrontKey" AS key FROM criminal_verification_forms
     WHERE "cnicFrontKey" IS NOT NULL AND "cnicFrontKey" LIKE '%/%' AND "cnicFrontKey" NOT LIKE 'http%'
     ORDER BY id ${limitClause}`);

  const cnicBack = await checkTable(db, 'criminal_verification_forms (cnicBackKey)',
    `SELECT id, "cnicBackKey" AS key FROM criminal_verification_forms
     WHERE "cnicBackKey" IS NOT NULL AND "cnicBackKey" LIKE '%/%' AND "cnicBackKey" NOT LIKE 'http%'
     ORDER BY id ${limitClause}`);

  const facePhoto = await checkTable(db, 'criminal_verification_forms (facePhotoKey)',
    `SELECT id, "facePhotoKey" AS key FROM criminal_verification_forms
     WHERE "facePhotoKey" IS NOT NULL AND "facePhotoKey" LIKE '%/%' AND "facePhotoKey" NOT LIKE 'http%'
     ORDER BY id ${limitClause}`);

  const receipts = await checkTable(db, 'invoices (receiptKey)',
    `SELECT id, "receiptKey" AS key FROM invoices
     WHERE "receiptKey" IS NOT NULL
     ORDER BY id ${limitClause}`);

  const logos = await checkTable(db, 'companies (logoKey)',
    `SELECT id, "logoKey" AS key FROM companies
     WHERE "logoKey" IS NOT NULL AND "logoKey" LIKE '%/%' AND "logoKey" NOT LIKE 'http%'
     ORDER BY id ${limitClause}`);

  console.log('\n=== SUMMARY ===');
  const all = [
    { label: 'worker_documents', ...docs },
    { label: 'cnicFrontKey', ...cnicFront },
    { label: 'cnicBackKey', ...cnicBack },
    { label: 'facePhotoKey', ...facePhoto },
    { label: 'receiptKey', ...receipts },
    { label: 'logoKey', ...logos },
  ];
  let totalMissing = 0;
  for (const t of all) {
    console.log(`  ${t.label}: ${t.missing} missing / ${t.total} total`);
    totalMissing += t.missing;
  }
  console.log(`\n  TOTAL MISSING: ${totalMissing}`);

  // Write missing keys to a file for recovery
  if (totalMissing > 0) {
    const fs = require('fs');
    const missingReport = {};
    for (const t of all) {
      if (t.missingKeys.length > 0) {
        missingReport[t.label] = t.missingKeys;
      }
    }
    fs.writeFileSync('missing-keys-report.json', JSON.stringify(missingReport, null, 2));
    console.log('\n  Missing keys written to missing-keys-report.json');
  }
}

main()
  .catch((err) => { console.error('Failed:', err); process.exitCode = 1; })
  .finally(() => closeNewDb());
