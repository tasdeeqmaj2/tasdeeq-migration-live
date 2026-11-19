const crypto = require('crypto');
const { logError } = require('./logger');

const DEFAULT_BATCH_SIZE = Number(process.env.MIGRATE_BATCH_SIZE) || 2000;
const MAP_SAVE_EVERY = Number(process.env.MAP_SAVE_EVERY) || 10;

/**
 * Keyset-paginate over an ordered id column.
 * queryFn(lastId, limit) must return rows with an `id` field (or use idField).
 */
async function forEachBatch(queryFn, handler, options = {}) {
  const size = options.size || DEFAULT_BATCH_SIZE;
  const idField = options.idField || 'id';
  let lastId = options.startAfter ?? 0;
  let batchIndex = 0;

  for (;;) {
    const rows = await queryFn(lastId, size);
    if (!rows || rows.length === 0) break;

    await handler(rows, { batchIndex, size });
    batchIndex += 1;

    const last = rows[rows.length - 1];
    lastId = last[idField];
    if (rows.length < size) break;
  }

  return { batches: batchIndex };
}

/**
 * Run work inside a transaction. On failure, rollback and rethrow.
 */
async function withTransaction(client, fn) {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Process a batch: try all-at-once in a transaction; on failure, retry row-by-row.
 * Prefer bulkInsertWithFallback for new migrations.
 */
async function processBatchWithFallback(pool, rows, insertOne, { migration }) {
  const client = await pool.connect();
  try {
    const patches = await withTransaction(client, async (tx) => {
      const batchPatches = [];
      for (const row of rows) {
        const patch = await insertOne(tx, row);
        if (patch) batchPatches.push(patch);
      }
      return batchPatches;
    });
    return { succeeded: rows.length, failed: 0, patches };
  } catch {
    // Batch failed — retry individually so good rows still land
  } finally {
    client.release();
  }

  const patches = [];
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    const rowClient = await pool.connect();
    try {
      const patch = await withTransaction(rowClient, async (tx) => {
        return insertOne(tx, row);
      });
      succeeded += 1;
      if (patch) patches.push(patch);
    } catch (err) {
      failed += 1;
      logError({
        migration,
        oldId: row.id ?? row.employment_id ?? row.oldId ?? row.mapKey ?? null,
        message: err.message,
        stack: err.stack,
      });
    } finally {
      rowClient.release();
    }
  }

  return { succeeded, failed, patches };
}

function createId() {
  const time = Date.now().toString(36);
  const rand = crypto.randomBytes(10).toString('hex');
  return `c${time}${rand}`.slice(0, 25);
}

/** True every N batches (and always for batch 0 if you want first save). */
function shouldSaveMaps(batchIndex) {
  return (batchIndex + 1) % MAP_SAVE_EVERY === 0;
}

module.exports = {
  forEachBatch,
  withTransaction,
  processBatchWithFallback,
  createId,
  shouldSaveMaps,
  DEFAULT_BATCH_SIZE,
  MAP_SAVE_EVERY,
};
