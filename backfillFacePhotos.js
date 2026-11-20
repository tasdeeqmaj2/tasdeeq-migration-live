/**
 * Backfill facePhotoKey for criminal_verification_forms that were migrated
 * before the face photo column was added to the migration.
 *
 * Looks up the original picture_link from old DB and writes it to facePhotoKey.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { section, info, success, warn, logError, flushErrors } = require('./utils/logger');
const { normalizeLegacyFileRef } = require('./utils/legacyFiles');

const TASK_MAP_NAME = 'verificationTaskMap.json';
const BATCH = 500;
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY) || 20;

function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
    .then(() => results);
}

async function main() {
  section('Backfill facePhotoKey for criminal_verification_forms');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const taskMap = loadMap(TASK_MAP_NAME);

  // Find forms that have no facePhotoKey
  const { rows: countRows } = await newDb.query(`
    SELECT COUNT(*)::int AS cnt FROM criminal_verification_forms
    WHERE "facePhotoKey" IS NULL
  `);
  info(`Forms with NULL facePhotoKey: ${countRows[0].cnt}`);

  if (countRows[0].cnt === 0) {
    success('Nothing to backfill');
    return;
  }

  // Build reverse map: newTaskId -> oldEmploymentId
  const reverseTaskMap = {};
  for (const [oldId, newId] of Object.entries(taskMap)) {
    reverseTaskMap[newId] = oldId;
  }

  let updated = 0;
  let noSource = 0;
  let processed = 0;
  let lastId = '';

  for (;;) {
    const { rows } = await newDb.query(`
      SELECT id, "taskId"
      FROM criminal_verification_forms
      WHERE "facePhotoKey" IS NULL AND id > $1
      ORDER BY id
      LIMIT $2
    `, [lastId, BATCH]);

    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;
    processed += rows.length;

    // Collect old employment IDs for this batch
    const batchWithOldIds = rows
      .map(r => ({ ...r, oldId: reverseTaskMap[r.taskId] }))
      .filter(r => r.oldId);

    if (batchWithOldIds.length === 0) {
      noSource += rows.length;
      continue;
    }

    const oldIds = batchWithOldIds.map(r => Number(r.oldId));

    // Load face photos from old DB: worker.picture_link and document.picture_link
    const [workerPhotos, docPhotos] = await Promise.all([
      oldDb.query(`
        SELECT e.id AS employment_id, w.picture_link
        FROM user_worker_employment e
        INNER JOIN worker w ON w.id = e.worker_id
        WHERE e.id = ANY($1::bigint[])
          AND w.picture_link IS NOT NULL AND w.picture_link <> ''
      `, [oldIds]),
      oldDb.query(`
        SELECT DISTINCT ON (d.user_worker_employment_id)
          d.user_worker_employment_id AS employment_id,
          d.picture_link
        FROM user_worker_employment_document d
        WHERE d.is_active IS DISTINCT FROM false
          AND d.user_worker_employment_id = ANY($1::bigint[])
          AND d.picture_link IS NOT NULL AND d.picture_link <> ''
        ORDER BY d.user_worker_employment_id, d.id DESC
      `, [oldIds]),
    ]);

    const workerPhotoMap = new Map();
    for (const r of workerPhotos.rows) workerPhotoMap.set(Number(r.employment_id), r.picture_link);
    const docPhotoMap = new Map();
    for (const r of docPhotos.rows) docPhotoMap.set(Number(r.employment_id), r.picture_link);

    await mapPool(batchWithOldIds, CONCURRENCY, async (row) => {
      const oldEmpId = Number(row.oldId);
      const facePhoto =
        normalizeLegacyFileRef(docPhotoMap.get(oldEmpId)) ||
        normalizeLegacyFileRef(workerPhotoMap.get(oldEmpId));

      if (!facePhoto) {
        noSource++;
        return;
      }

      await newDb.query(
        `UPDATE criminal_verification_forms SET "facePhotoKey" = $1 WHERE id = $2`,
        [facePhoto, row.id]
      );
      updated++;
    });

    info(`  Progress: processed=${processed} updated=${updated} noSource=${noSource}`);
  }

  flushErrors();
  success(`Backfill done: ${updated} updated, ${noSource} no source photo`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
