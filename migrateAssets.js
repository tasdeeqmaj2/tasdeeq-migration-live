/**
 * Background job: convert legacy download-asset URLs already stored in the NEW DB
 * into MinIO object keys (same contract as Nest StorageService.upload).
 *
 * Run AFTER `npm run migrate` / `migrate:fresh` finishes:
 *   npm run migrate:assets
 *
 * Safe to re-run (idempotent via assetMap + skipping rows that already look like MinIO keys).
 */
// See index.js — keep Node in UTC so timestamps match Prisma's convention.
process.env.TZ = 'UTC';
require('dotenv').config();

const { getNewDb, closeNewDb } = require('./db/newDb');
const {
  info,
  section,
  success,
  warn,
  flushErrors,
  logError,
} = require('./utils/logger');
const { formatCount } = require('./utils/progress');
const {
  migrateAsset,
  saveAssetMap,
  getConcurrency,
  mapPool,
  isOldAssetUrl,
  isNewMinioKey,
  mimeFromFileName,
  extractAssetName,
} = require('./utils/migrateAsset');

const BATCH = Number(process.env.ASSET_JOB_BATCH_SIZE) || 200;

function needsMigration(value) {
  if (value == null || String(value).trim() === '') return false;
  if (isNewMinioKey(value)) return false;
  return isOldAssetUrl(value) || /^https?:\/\//i.test(String(value));
}

async function countPending(db) {
  const r = await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM companies
         WHERE "logoKey" IS NOT NULL AND btrim("logoKey") <> ''
           AND ("logoKey" ILIKE '%download-asset%' OR "logoKey" ILIKE 'http%')) AS companies,
      (SELECT COUNT(*)::int FROM worker_documents
         WHERE key IS NOT NULL AND btrim(key) <> ''
           AND (key ILIKE '%download-asset%' OR key ILIKE 'http%')) AS documents,
      (SELECT COUNT(*)::int FROM criminal_verification_forms
         WHERE (
           ("cnicFrontKey" IS NOT NULL AND btrim("cnicFrontKey") <> ''
             AND ("cnicFrontKey" ILIKE '%download-asset%' OR "cnicFrontKey" ILIKE 'http%'))
           OR
           ("cnicBackKey" IS NOT NULL AND btrim("cnicBackKey") <> ''
             AND ("cnicBackKey" ILIKE '%download-asset%' OR "cnicBackKey" ILIKE 'http%'))
           OR
           ("facePhotoKey" IS NOT NULL AND btrim("facePhotoKey") <> ''
             AND ("facePhotoKey" ILIKE '%download-asset%' OR "facePhotoKey" ILIKE 'http%'))
         )) AS forms
  `);
  return r.rows[0];
}

async function processCompanies(db, stats) {
  section('Asset job: companies.logoKey');
  let lastId = '';
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, "logoKey" AS ref
       FROM companies
       WHERE id > $1
         AND "logoKey" IS NOT NULL AND btrim("logoKey") <> ''
         AND ("logoKey" ILIKE '%download-asset%' OR "logoKey" ILIKE 'http%')
       ORDER BY id
       LIMIT $2`,
      [lastId, BATCH]
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    await mapPool(rows, getConcurrency(), async (row) => {
      if (!needsMigration(row.ref)) {
        stats.skipped += 1;
        return;
      }
      const key = await migrateAsset(row.ref, {
        folder: 'uploads',
        migration: 'asset_job_companies',
        oldId: row.id,
        table: 'companies',
      });
      if (!key || key === row.ref) {
        stats.failed += 1;
        return;
      }
      await db.query(`UPDATE companies SET "logoKey" = $1 WHERE id = $2`, [
        key,
        row.id,
      ]);
      stats.updated += 1;
    });

    saveAssetMap();
    info(
      `  companies progress: updated=${formatCount(stats.updated)} failed=${formatCount(stats.failed)} (last id ${lastId.slice(0, 12)}…)`
    );
  }
}

async function processDocuments(db, stats) {
  section('Asset job: worker_documents.key');
  let lastId = '';
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, key AS ref, "fileType"
       FROM worker_documents
       WHERE id > $1
         AND key IS NOT NULL AND btrim(key) <> ''
         AND (key ILIKE '%download-asset%' OR key ILIKE 'http%')
       ORDER BY id
       LIMIT $2`,
      [lastId, BATCH]
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    await mapPool(rows, getConcurrency(), async (row) => {
      if (!needsMigration(row.ref)) {
        stats.skipped += 1;
        return;
      }
      const key = await migrateAsset(row.ref, {
        folder: 'worker-documents',
        migration: 'asset_job_documents',
        oldId: row.id,
        table: 'worker_documents',
      });
      if (!key || key === row.ref) {
        stats.failed += 1;
        return;
      }
      const fileType =
        mimeFromFileName(extractAssetName(row.ref)) || row.fileType;
      await db.query(
        `UPDATE worker_documents SET key = $1, "fileType" = $2 WHERE id = $3`,
        [key, fileType, row.id]
      );
      stats.updated += 1;
    });

    saveAssetMap();
    info(
      `  documents progress: updated=${formatCount(stats.updated)} failed=${formatCount(stats.failed)} (last id ${lastId.slice(0, 12)}…)`
    );
  }
}

async function processForms(db, stats) {
  section('Asset job: criminal_verification_forms CNIC + face photo keys');
  let lastId = '';
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, "cnicFrontKey", "cnicBackKey", "facePhotoKey"
       FROM criminal_verification_forms
       WHERE id > $1
         AND (
           ("cnicFrontKey" IS NOT NULL AND btrim("cnicFrontKey") <> ''
             AND ("cnicFrontKey" ILIKE '%download-asset%' OR "cnicFrontKey" ILIKE 'http%'))
           OR
           ("cnicBackKey" IS NOT NULL AND btrim("cnicBackKey") <> ''
             AND ("cnicBackKey" ILIKE '%download-asset%' OR "cnicBackKey" ILIKE 'http%'))
           OR
           ("facePhotoKey" IS NOT NULL AND btrim("facePhotoKey") <> ''
             AND ("facePhotoKey" ILIKE '%download-asset%' OR "facePhotoKey" ILIKE 'http%'))
         )
       ORDER BY id
       LIMIT $2`,
      [lastId, BATCH]
    );
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    await mapPool(rows, getConcurrency(), async (row) => {
      let front = row.cnicFrontKey;
      let back = row.cnicBackKey;
      let face = row.facePhotoKey;
      let changed = false;

      if (needsMigration(front)) {
        const key = await migrateAsset(front, {
          folder: 'cnic-images',
          migration: 'asset_job_forms',
          oldId: row.id,
          table: 'criminal_verification_forms',
        });
        if (key && key !== front) {
          front = key;
          changed = true;
        } else if (needsMigration(row.cnicFrontKey)) {
          stats.failed += 1;
        }
      }

      if (needsMigration(back)) {
        const key = await migrateAsset(back, {
          folder: 'cnic-images',
          migration: 'asset_job_forms',
          oldId: row.id,
          table: 'criminal_verification_forms',
        });
        if (key && key !== back) {
          back = key;
          changed = true;
        } else if (needsMigration(row.cnicBackKey)) {
          stats.failed += 1;
        }
      }

      if (needsMigration(face)) {
        const key = await migrateAsset(face, {
          folder: 'face-photos',
          migration: 'asset_job_forms',
          oldId: row.id,
          table: 'criminal_verification_forms',
        });
        if (key && key !== face) {
          face = key;
          changed = true;
        } else if (needsMigration(row.facePhotoKey)) {
          stats.failed += 1;
        }
      }

      if (changed) {
        await db.query(
          `UPDATE criminal_verification_forms
           SET "cnicFrontKey" = $1, "cnicBackKey" = $2, "facePhotoKey" = $3
           WHERE id = $4`,
          [front, back, face, row.id]
        );
        stats.updated += 1;
      }
    });

    saveAssetMap();
    info(
      `  forms progress: updated=${formatCount(stats.updated)} failed=${formatCount(stats.failed)} (last id ${lastId.slice(0, 12)}…)`
    );
  }
}

async function main() {
  section('Tasdeeq Asset Migration Job (background)');

  if (!process.env.NEW_DATABASE_URL) {
    throw new Error('NEW_DATABASE_URL is not set');
  }

  const db = getNewDb();
  await db.query('SELECT 1');
  info(`Concurrency: ${getConcurrency()}`);
  info(`Batch size: ${BATCH}`);

  const pending = await countPending(db);
  info(
    `Pending legacy refs — companies: ${formatCount(pending.companies)}, documents: ${formatCount(pending.documents)}, forms: ${formatCount(pending.forms)}`
  );

  if (
    pending.companies === 0 &&
    pending.documents === 0 &&
    pending.forms === 0
  ) {
    success('Nothing to do — no legacy asset URLs found');
    return;
  }

  const companyStats = { updated: 0, failed: 0, skipped: 0 };
  const docStats = { updated: 0, failed: 0, skipped: 0 };
  const formStats = { updated: 0, failed: 0, skipped: 0 };

  await processCompanies(db, companyStats);
  await processDocuments(db, docStats);
  await processForms(db, formStats);

  saveAssetMap();
  flushErrors();

  section('Asset job completed');
  success(
    `Companies: ${formatCount(companyStats.updated)} updated, ${formatCount(companyStats.failed)} failed`
  );
  success(
    `Documents: ${formatCount(docStats.updated)} updated, ${formatCount(docStats.failed)} failed`
  );
  success(
    `Forms: ${formatCount(formStats.updated)} updated, ${formatCount(formStats.failed)} failed`
  );

  const left = await countPending(db);
  if (left.companies + left.documents + left.forms > 0) {
    warn(
      `Still pending — companies: ${left.companies}, documents: ${left.documents}, forms: ${left.forms} (re-run migrate:assets)`
    );
  } else {
    success('All legacy asset URLs converted to MinIO keys');
  }
}

module.exports = { main };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('\nAsset job failed:', err.message);
      if (err.stack) console.error(err.stack);
      logError({
        migration: 'asset_job',
        oldId: null,
        message: err.message,
        stack: err.stack,
      });
      flushErrors();
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeNewDb();
    });
}