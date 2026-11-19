const { getOldDb } = require('../db/oldDb');
const { getNewDb } = require('../db/newDb');
const { section, success, info } = require('../utils/logger');
const { reportDone, reportProgress } = require('../utils/progress');
const { loadMap, saveMap } = require('../utils/maps');
const {
  forEachBatch,
  createId,
  shouldSaveMaps,
} = require('../utils/batch');
const { bulkInsertWithFallback } = require('../utils/bulk');
const { decryptLegacy } = require('../utils/decrypt');
const {
  normalizeLegacyFileRef,
  docNameFromVerificationType,
} = require('../utils/legacyFiles');

const UDV_MAP_NAME = 'userDocumentVerificationMap.json';
const WORKER_MAP_NAME = 'workerMap.json';

/** User requested batch size for UDV step */
const UDV_BATCH_SIZE = Number(process.env.UDV_BATCH_SIZE) || 500;
const UDV_BULK_CHUNK = Number(process.env.UDV_BULK_CHUNK) || 500;

function inferFileType(key) {
  if (!key) return 'application/octet-stream';
  const path = require('path');
  const assetMatch = String(key).match(/asset_name=([^&]+)/i);
  const nameForExt = assetMatch
    ? decodeURIComponent(assetMatch[1])
    : String(key).split('?')[0];
  const ext = path.extname(nameForExt).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

function buildCnicToWorkerIds(oldEmployments, workerMap) {
  /** @type {Record<string, Set<string>>} */
  const index = {};

  for (const row of oldEmployments) {
    const workerId = workerMap[String(row.employment_id)];
    if (!workerId) continue;
    const cnic = row.cnic && decryptLegacy(String(row.cnic).trim());
    if (!cnic) continue;
    if (!index[cnic]) index[cnic] = new Set();
    index[cnic].add(workerId);
  }

  return index;
}

async function loadActiveEmploymentCnics(oldDb) {
  info('Building CNIC → worker index for document verification...');
  const rows = [];
  let batches = 0;

  await forEachBatch(
    async (lastId, limit) => {
      const result = await oldDb.query(
        `SELECT e.id AS employment_id, w.cnic
         FROM user_worker_employment e
         INNER JOIN worker w ON w.id = e.worker_id
         WHERE e.is_active = true
           AND e.id > $1
         ORDER BY e.id
         LIMIT $2`,
        [lastId, limit]
      );
      return result.rows.map((r) => ({ ...r, id: r.employment_id }));
    },
    async (batch, { batchIndex }) => {
      rows.push(...batch);
      batches = batchIndex + 1;
      if ((batchIndex + 1) % 20 === 0) {
        info(`  CNIC index: loaded ${rows.length.toLocaleString()} employments...`);
      }
    },
    { size: UDV_BATCH_SIZE, idField: 'employment_id' }
  );

  info(`  CNIC index ready (${rows.length.toLocaleString()} employments, ${batches} batches)`);
  return rows;
}

async function countSourceUdvRows(oldDb) {
  const result = await oldDb.query(`
    SELECT COUNT(*)::int AS count
    FROM user_document_verification udv
    WHERE (udv.is_active IS DISTINCT FROM false)
      AND udv.document_link IS NOT NULL
      AND btrim(udv.document_link) <> ''
  `);
  return result.rows[0].count;
}

async function migrateUserDocumentVerification(systemUserId) {
  section('Migrating User Document Verification...');

  if (!systemUserId) {
    throw new Error('systemUserId is required for UDV migration');
  }

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const udvMap = loadMap(UDV_MAP_NAME);
  const workerMap = loadMap(WORKER_MAP_NAME);

  const alreadyMapped = Object.keys(udvMap).length;
  if (alreadyMapped > 0) {
    info(`Resuming: ${alreadyMapped.toLocaleString()} map entries already present`);
  }

  info(`Batch size: ${UDV_BATCH_SIZE} (bulk insert chunks: ${UDV_BULK_CHUNK})`);

  const employments = await loadActiveEmploymentCnics(oldDb);
  const cnicIndex = buildCnicToWorkerIds(employments, workerMap);
  info(`CNIC matches: ${Object.keys(cnicIndex).length.toLocaleString()} unique CNICs`);

  const sourceTotal = await countSourceUdvRows(oldDb);
  info(`Source UDV rows to scan: ${sourceTotal.toLocaleString()}`);

  let inserted = 0;
  let skipped = 0;
  let unmatched = 0;
  let processed = 0;
  let batchNum = 0;

  await forEachBatch(
    async (lastId, limit) => {
      const result = await oldDb.query(
        `SELECT
           udv.id,
           udv.user_id,
           udv.document_link,
           udv.is_active,
           udv.approved_at,  -- created_at is TIME-only in legacy schema
           u.cnic AS user_cnic,
           vt.document_type
         FROM user_document_verification udv
         INNER JOIN "user" u ON u.id = udv.user_id
         LEFT JOIN verification_type vt ON vt.id = udv.verification_type_id
         WHERE udv.id > $1
         ORDER BY udv.id
         LIMIT $2`,
        [lastId, limit]
      );
      return result.rows;
    },
    async (rows, { batchIndex }) => {
      batchNum = batchIndex + 1;
      processed += rows.length;

      const toInsert = [];
      const now = new Date();
      let batchSkipped = 0;
      let batchUnmatched = 0;

      for (const row of rows) {
        if (row.is_active === false) continue;

        const link = normalizeLegacyFileRef(row.document_link);
        if (!link) continue;

        const oldId = String(row.id);
        if (udvMap[oldId]) {
          skipped += 1;
          batchSkipped += 1;
          continue;
        }

        const plainCnic = decryptLegacy(row.user_cnic);
        const workerIds = plainCnic ? cnicIndex[String(plainCnic).trim()] : null;

        if (!workerIds || workerIds.size === 0) {
          unmatched += 1;
          batchUnmatched += 1;
          continue;
        }

        const docName = docNameFromVerificationType(row.document_type);
        for (const workerId of workerIds) {
          const mapKey = `${oldId}:${workerId}`;
          if (udvMap[mapKey]) {
            skipped += 1;
            batchSkipped += 1;
            continue;
          }
          const newId = createId();
          toInsert.push({
            id: row.id,
            oldId,
            mapKey,
            newId,
            values: [
              newId,
              workerId,
              // Legacy URL — convert via `npm run migrate:assets`
              link,
              docName,
              inferFileType(link),
              systemUserId,
              row.approved_at || now,
            ],
          });
        }
      }

      let batchAdded = 0;
      if (toInsert.length > 0) {
        const { succeeded } = await bulkInsertWithFallback(
          newDb,
          'worker_documents',
          [
            'id',
            '"workerId"',
            'key',
            'name',
            '"fileType"',
            '"uploadedById"',
            '"createdAt"',
          ],
          toInsert,
          {
            migration: 'user_document_verification',
            chunkSize: UDV_BULK_CHUNK,
            toValues: (item) => item.values,
            onSuccess: (chunk) => {
              for (const item of chunk) {
                udvMap[item.mapKey] = item.newId;
                if (!udvMap[item.oldId]) udvMap[item.oldId] = item.newId;
              }
            },
          }
        );
        batchAdded = succeeded;
        inserted += succeeded;
      }

      reportProgress('User Document Verification', {
        added: inserted,
        processed,
        total: sourceTotal,
        skipped,
        unmatched,
        batch: batchNum,
      });

      if (batchAdded > 0 || batchSkipped > 0 || batchUnmatched > 0) {
        info(
          `  batch ${batchNum}: +${batchAdded.toLocaleString()} docs this batch` +
            ` (skipped ${batchSkipped.toLocaleString()}, unmatched ${batchUnmatched.toLocaleString()})`
        );
      }

      if (shouldSaveMaps(batchIndex)) {
        saveMap(UDV_MAP_NAME, udvMap);
      }
    },
    { size: UDV_BATCH_SIZE }
  );

  saveMap(UDV_MAP_NAME, udvMap);

  reportProgress('User Document Verification (done)', {
    added: inserted,
    processed,
    total: sourceTotal,
    skipped,
    unmatched,
  });

  reportDone('User Document Verification map entries', Object.keys(udvMap).length);
  reportDone('Documents added from UDV', inserted);
  if (skipped > 0) success(`${skipped} already mapped / duplicates (skipped)`);
  if (unmatched > 0) {
    success(`${unmatched} UDV rows with no worker CNIC match (skipped)`);
  }

  return { udvMap, inserted, skipped, unmatched, processed, sourceTotal };
}

module.exports = { migrateUserDocumentVerification };
