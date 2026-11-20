/**
 * Migrate receipt images: S3 copy from tasdeeqimage → tasdeeq-prod-assets/receipts/
 * Then update invoice.receiptKey + receiptUploadedAt on matching MIG invoices.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const { S3Client, CopyObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');
const path = require('path');
const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { section, info, success, warn, flushErrors } = require('./utils/logger');

const s3 = new S3Client({
  region: process.env.S3_REGION || 'us-east-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY,
  },
});

const OLD_BUCKET = 'tasdeeqimage';
const NEW_BUCKET = process.env.S3_BUCKET || 'tasdeeq-prod-assets';

function extractFileKey(url) {
  if (!url) return null;
  if (url.includes('asset_name=')) {
    const match = url.match(/asset_name=(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  if (url.includes('amazonaws.com/')) {
    const match = url.match(/amazonaws\.com\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  return null;
}

function getExtension(filename) {
  const ext = path.extname(filename).toLowerCase().replace('.', '');
  return ext || 'jpg';
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', pdf: 'application/pdf', webp: 'image/webp' };

async function copyInS3(sourceKey, destKey, ext) {
  await s3.send(new CopyObjectCommand({
    Bucket: NEW_BUCKET,
    CopySource: `${OLD_BUCKET}/${encodeURIComponent(sourceKey)}`,
    Key: destKey,
    ContentType: MIME[ext] || 'application/octet-stream',
    MetadataDirective: 'REPLACE',
  }));
}

async function main() {
  section('Migrate receipt images (S3 → S3 copy)');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap('companyMap.json');

  // Build oldUserId → companyId map
  const userToCompany = {};
  for (const [oldUserId, companyId] of Object.entries(companyMap)) {
    const stripped = String(oldUserId).replace(/^hh-/, '');
    const num = Number(stripped);
    if (!isNaN(num)) userToCompany[num] = companyId;
  }

  // Load old invoices with receipts
  section('Loading old invoices with receipt documents');
  const { rows: oldInvoices } = await oldDb.query(`
    SELECT id, user_id, invoice_number, invoice_document, amount, date, payment_status, status
    FROM public.worker_purchase_invoice
    WHERE invoice_document IS NOT NULL AND invoice_document != ''
    ORDER BY user_id, date ASC
  `);
  info(`Old invoices with receipts: ${oldInvoices.length}`);

  // Pre-load all MIG invoices grouped by company for fast matching
  section('Loading MIG invoices from new DB');
  const companyIds = [...new Set(Object.values(userToCompany))];
  const migInvoicesByCompany = {};

  for (let i = 0; i < companyIds.length; i += 5000) {
    const chunk = companyIds.slice(i, i + 5000);
    const { rows } = await newDb.query(`
      SELECT id, "companyId", "invoiceNumber", "createdAt", "receiptKey"
      FROM invoices
      WHERE "companyId" = ANY($1::text[])
        AND "invoiceNumber" LIKE 'MIG-%'
      ORDER BY "companyId", "createdAt" ASC
    `, [chunk]);
    for (const r of rows) {
      if (!migInvoicesByCompany[r.companyId]) migInvoicesByCompany[r.companyId] = [];
      migInvoicesByCompany[r.companyId].push(r);
    }
  }
  info(`Companies with MIG invoices: ${Object.keys(migInvoicesByCompany).length}`);

  let copied = 0;
  let skippedNoCompany = 0;
  let skippedNoKey = 0;
  let skippedNoMatch = 0;
  let skippedAlreadyDone = 0;
  let failed = 0;

  for (let i = 0; i < oldInvoices.length; i++) {
    const row = oldInvoices[i];
    const oldUserId = Number(row.user_id);
    const companyId = userToCompany[oldUserId];

    if (!companyId) { skippedNoCompany++; continue; }

    const sourceKey = extractFileKey(row.invoice_document);
    if (!sourceKey) { skippedNoKey++; continue; }

    const companyInvoices = migInvoicesByCompany[companyId];
    if (!companyInvoices || companyInvoices.length === 0) { skippedNoMatch++; continue; }

    // Find best matching invoice by date (closest, without receipt)
    const invoiceDate = new Date(row.date);
    let bestMatch = null;
    let bestDiff = Infinity;
    for (const inv of companyInvoices) {
      if (inv.receiptKey) continue; // already has receipt
      const diff = Math.abs(new Date(inv.createdAt).getTime() - invoiceDate.getTime());
      if (diff < bestDiff) {
        bestDiff = diff;
        bestMatch = inv;
      }
    }

    if (!bestMatch) { skippedAlreadyDone++; continue; }

    try {
      const ext = getExtension(sourceKey);
      const destKey = `receipts/${randomUUID()}.${ext}`;

      await copyInS3(sourceKey, destKey, ext);

      await newDb.query(`
        UPDATE invoices SET "receiptKey" = $1, "receiptUploadedAt" = $2 WHERE id = $3
      `, [destKey, invoiceDate, bestMatch.id]);

      // Mark as used so it's not matched again
      bestMatch.receiptKey = destKey;

      copied++;
    } catch (err) {
      warn(`Failed old invoice ${row.id} (${sourceKey}): ${err.message}`);
      failed++;
    }

    if ((i + 1) % 500 === 0) {
      info(`  Progress: ${i + 1}/${oldInvoices.length} — copied: ${copied}, failed: ${failed}`);
    }
  }

  flushErrors();
  success(`Done!
  Total old receipts: ${oldInvoices.length}
  Copied to S3: ${copied}
  Skipped (no company mapping): ${skippedNoCompany}
  Skipped (no file key): ${skippedNoKey}
  Skipped (no matching invoice): ${skippedNoMatch}
  Skipped (all invoices already have receipts): ${skippedAlreadyDone}
  Failed: ${failed}`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
