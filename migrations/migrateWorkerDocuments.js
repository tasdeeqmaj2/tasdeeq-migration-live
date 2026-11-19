const path = require('path');
const { getOldDb } = require('../db/oldDb');
const { getNewDb } = require('../db/newDb');
const { section, success } = require('../utils/logger');
const { reportDone } = require('../utils/progress');
const { loadMap, saveMap } = require('../utils/maps');
const {
  forEachBatch,
  createId,
  shouldSaveMaps,
  DEFAULT_BATCH_SIZE,
} = require('../utils/batch');
const { bulkInsertWithFallback } = require('../utils/bulk');
const { normalizeLegacyFileRef } = require('../utils/legacyFiles');

const DOCUMENT_MAP_NAME = 'documentMap.json';
const WORKER_MAP_NAME = 'workerMap.json';

function inferFileType(key) {
  if (!key) return 'application/octet-stream';
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

function expandDocuments(row, workerId, mapPrefix) {
  const kinds = [
    { kind: 'cnic-front', key: row.cnic_front_picture_link, name: 'cnic-front' },
    { kind: 'cnic-back', key: row.cnic_back_picture_link, name: 'cnic-back' },
    { kind: 'photo', key: row.picture_link, name: 'photo' },
  ];

  const docs = [];
  for (const item of kinds) {
    // Store legacy URL for now — `npm run migrate:assets` uploads to MinIO later
    const key = normalizeLegacyFileRef(item.key);
    if (!key) continue;
    docs.push({
      id: row.id,
      mapKey: `${mapPrefix}:${item.kind}`,
      workerId,
      key,
      name: item.name,
      fileType: inferFileType(key),
    });
  }
  return docs;
}

async function insertDocsBulk(
  newDb,
  documentMap,
  toInsert,
  systemUserId,
  migration
) {
  if (toInsert.length === 0) return 0;
  const now = new Date();

  const items = toInsert.map((doc) => {
    const newId = createId();
    return {
      id: doc.id,
      mapKey: doc.mapKey,
      newId,
      values: [
        newId,
        doc.workerId,
        doc.key,
        doc.name,
        doc.fileType,
        systemUserId,
        now,
      ],
    };
  });

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
    items,
    {
      migration,
      chunkSize: 1000,
      toValues: (item) => item.values,
      onSuccess: (chunk) => {
        for (const item of chunk) {
          documentMap[item.mapKey] = item.newId;
        }
      },
    }
  );

  return succeeded;
}

async function migrateEmploymentDocuments(
  oldDb,
  newDb,
  documentMap,
  workerMap,
  systemUserId
) {
  let inserted = 0;
  let skipped = 0;

  await forEachBatch(
    async (lastId, limit) => {
      const result = await oldDb.query(
        `SELECT
           d.id,
           d.cnic_front_picture_link,
           d.cnic_back_picture_link,
           d.picture_link,
           d.is_active,
           d.user_worker_employment_id
         FROM user_worker_employment_document d
         WHERE d.id > $1
         ORDER BY d.id
         LIMIT $2`,
        [lastId, limit]
      );
      return result.rows;
    },
    async (rows, { batchIndex }) => {
      const toInsert = [];
      for (const row of rows) {
        if (row.is_active === false) continue;
        const workerId = workerMap[String(row.user_worker_employment_id)];
        if (!workerId) continue;

        for (const doc of expandDocuments(row, workerId, String(row.id))) {
          if (documentMap[doc.mapKey]) {
            skipped += 1;
            continue;
          }
          toInsert.push(doc);
        }
      }

      inserted += await insertDocsBulk(
        newDb,
        documentMap,
        toInsert,
        systemUserId,
        'worker_documents'
      );
      if (shouldSaveMaps(batchIndex)) {
        saveMap(DOCUMENT_MAP_NAME, documentMap);
      }
    },
    { size: DEFAULT_BATCH_SIZE }
  );

  return { inserted, skipped };
}

async function migrateWorkerTableDocuments(
  oldDb,
  newDb,
  documentMap,
  workerMap,
  systemUserId
) {
  let inserted = 0;
  let skipped = 0;

  await forEachBatch(
    async (lastId, limit) => {
      const result = await oldDb.query(
        `SELECT
           e.id,
           w.picture_link,
           w.cnic_front_picture_link,
           w.cnic_back_picture_link
         FROM user_worker_employment e
         INNER JOIN worker w ON w.id = e.worker_id
         WHERE e.is_active = true
           AND e.id > $1
           AND (
             (w.picture_link IS NOT NULL AND btrim(w.picture_link) <> '')
             OR (w.cnic_front_picture_link IS NOT NULL AND btrim(w.cnic_front_picture_link) <> '')
             OR (w.cnic_back_picture_link IS NOT NULL AND btrim(w.cnic_back_picture_link) <> '')
           )
         ORDER BY e.id
         LIMIT $2`,
        [lastId, limit]
      );
      return result.rows;
    },
    async (rows, { batchIndex }) => {
      const toInsert = [];
      for (const row of rows) {
        const workerId = workerMap[String(row.id)];
        if (!workerId) continue;

        for (const doc of expandDocuments(
          row,
          workerId,
          `worker-table-${row.id}`
        )) {
          if (documentMap[doc.mapKey]) {
            skipped += 1;
            continue;
          }
          toInsert.push(doc);
        }
      }

      inserted += await insertDocsBulk(
        newDb,
        documentMap,
        toInsert,
        systemUserId,
        'worker_table_documents'
      );
      if (shouldSaveMaps(batchIndex)) {
        saveMap(DOCUMENT_MAP_NAME, documentMap);
      }
    },
    { size: DEFAULT_BATCH_SIZE }
  );

  return { inserted, skipped };
}

async function migrateWorkerDocuments(systemUserId) {
  section('Migrating Documents...');

  if (!systemUserId) {
    throw new Error('systemUserId is required for document migration');
  }

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const documentMap = loadMap(DOCUMENT_MAP_NAME);
  const workerMap = loadMap(WORKER_MAP_NAME);

  const fromEmp = await migrateEmploymentDocuments(
    oldDb,
    newDb,
    documentMap,
    workerMap,
    systemUserId
  );
  const fromWorker = await migrateWorkerTableDocuments(
    oldDb,
    newDb,
    documentMap,
    workerMap,
    systemUserId
  );

  saveMap(DOCUMENT_MAP_NAME, documentMap);
  reportDone('Documents', Object.keys(documentMap).length);
  if (fromEmp.skipped + fromWorker.skipped > 0) {
    success(`${fromEmp.skipped + fromWorker.skipped} already mapped (skipped)`);
  }
  if (fromWorker.inserted > 0) {
    success(`${fromWorker.inserted} from worker table fallback`);
  }

  return {
    documentMap,
    inserted: fromEmp.inserted + fromWorker.inserted,
    skipped: fromEmp.skipped + fromWorker.skipped,
  };
}

module.exports = { migrateWorkerDocuments };
