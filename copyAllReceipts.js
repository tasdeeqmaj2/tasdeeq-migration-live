/**
 * Copy ALL receipt images from tasdeeqimage → tasdeeq-prod-assets/receipts/
 * regardless of company mapping. Stores a JSON map of old invoice ID → new S3 key
 * so we can link them to invoices later.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { S3Client, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { randomUUID } = require('crypto');
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

async function main() {
  section('Copy ALL receipt images to S3');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap('companyMap.json');

  // Build oldUserId → companyId
  const userToCompany = {};
  for (const [oldUserId, companyId] of Object.entries(companyMap)) {
    const stripped = String(oldUserId).replace(/^hh-/, '');
    const num = Number(stripped);
    if (!isNaN(num)) userToCompany[num] = companyId;
  }

  // Load ALL old invoices with receipts
  const { rows: oldInvoices } = await oldDb.query(`
    SELECT id, user_id, invoice_document, date, amount, payment_status, status
    FROM public.worker_purchase_invoice
    WHERE invoice_document IS NOT NULL AND invoice_document != ''
    ORDER BY user_id, date ASC
  `);
  info(`Total old invoices with receipts: ${oldInvoices.length}`);

  // Load existing receipt mappings (from previous migrateReceipts run)
  const { rows: existingReceipts } = await newDb.query(`
    SELECT id, "receiptKey" FROM invoices WHERE "receiptKey" IS NOT NULL AND "invoiceNumber" LIKE 'MIG-%'
  `);
  info(`Invoices already with receipts: ${existingReceipts.length}`);

  // Track all copies: oldInvoiceId → { s3Key, oldUserId, date, amount }
  const receiptMap = {};
  // Load existing map if resuming
  const mapPath = path.join(__dirname, 'mappings', 'receiptMap.json');
  if (fs.existsSync(mapPath)) {
    const existing = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    Object.assign(receiptMap, existing);
    info(`Loaded existing receipt map: ${Object.keys(existing).length} entries`);
  }

  let copied = 0;
  let skipped = 0;
  let alreadyDone = 0;
  let failed = 0;

  for (let i = 0; i < oldInvoices.length; i++) {
    const row = oldInvoices[i];
    const oldId = String(row.id);

    // Skip if already copied
    if (receiptMap[oldId]) {
      alreadyDone++;
      continue;
    }

    const sourceKey = extractFileKey(row.invoice_document);
    if (!sourceKey) {
      warn(`No file key: ${row.invoice_document}`);
      skipped++;
      continue;
    }

    try {
      const ext = getExtension(sourceKey);
      const destKey = `receipts/${randomUUID()}.${ext}`;

      await s3.send(new CopyObjectCommand({
        Bucket: NEW_BUCKET,
        CopySource: `${OLD_BUCKET}/${encodeURIComponent(sourceKey)}`,
        Key: destKey,
        ContentType: MIME[ext] || 'application/octet-stream',
        MetadataDirective: 'REPLACE',
      }));

      receiptMap[oldId] = {
        s3Key: destKey,
        oldUserId: Number(row.user_id),
        date: row.date,
        amount: Number(row.amount),
        hasMapped: !!userToCompany[Number(row.user_id)],
      };

      copied++;

      // Also link to invoice if company mapping exists and not already linked
      const companyId = userToCompany[Number(row.user_id)];
      if (companyId) {
        const invoiceDate = new Date(row.date);
        const { rows: match } = await newDb.query(`
          SELECT id FROM invoices
          WHERE "companyId" = $1 AND "invoiceNumber" LIKE 'MIG-%' AND "receiptKey" IS NULL
          ORDER BY ABS(EXTRACT(EPOCH FROM ("createdAt" - $2::timestamp)))
          LIMIT 1
        `, [companyId, invoiceDate]);

        if (match.length > 0) {
          await newDb.query(`UPDATE invoices SET "receiptKey" = $1, "receiptUploadedAt" = $2 WHERE id = $3`,
            [destKey, invoiceDate, match[0].id]);
        }
      }
    } catch (err) {
      warn(`Failed old invoice ${row.id} (${sourceKey}): ${err.message}`);
      failed++;
    }

    if ((i + 1) % 500 === 0) {
      info(`  Progress: ${i + 1}/${oldInvoices.length} — copied: ${copied}, failed: ${failed}`);
      // Save progress
      fs.writeFileSync(mapPath, JSON.stringify(receiptMap, null, 2));
    }
  }

  // Final save
  fs.writeFileSync(mapPath, JSON.stringify(receiptMap, null, 2));

  flushErrors();
  success(`Done!
  Total old receipts: ${oldInvoices.length}
  Newly copied: ${copied}
  Already done: ${alreadyDone}
  Skipped (no key): ${skipped}
  Failed: ${failed}
  Receipt map saved: ${mapPath} (${Object.keys(receiptMap).length} entries)`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
