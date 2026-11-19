/**
 * Multi-row INSERT helper for fast migration.
 * columns: array of SQL column expressions, e.g. ['id', '"companyId"', 'name']
 * valueRows: array of value arrays aligned with columns
 */
async function bulkInsert(client, tableSql, columns, valueRows, options = {}) {
  const chunkSize = options.chunkSize || 1000;
  if (!valueRows.length) return 0;

  let inserted = 0;
  const colList = columns.join(', ');

  for (let i = 0; i < valueRows.length; i += chunkSize) {
    const chunk = valueRows.slice(i, i + chunkSize);
    const params = [];
    const tuples = [];
    let p = 1;

    for (const values of chunk) {
      if (values.length !== columns.length) {
        throw new Error(
          `bulkInsert column/value mismatch: ${columns.length} cols vs ${values.length} values`
        );
      }
      const placeholders = [];
      for (const v of values) {
        placeholders.push(`$${p++}`);
        params.push(v);
      }
      tuples.push(`(${placeholders.join(', ')})`);
    }

    const conflict = options.onConflict ? ` ${options.onConflict}` : '';
    const sql = `INSERT INTO ${tableSql} (${colList}) VALUES ${tuples.join(', ')}${conflict}`;
    await client.query(sql, params);
    inserted += chunk.length;
  }

  return inserted;
}

/**
 * Run bulk insert in a transaction. On failure, split in half recursively,
 * then fall back to single-row inserts for bad rows.
 */
async function bulkInsertWithFallback(pool, tableSql, columns, items, options = {}) {
  const { migration, toValues, onSuccess, chunkSize = 1000, onConflict } = options;
  if (!items.length) return { succeeded: 0, failed: 0 };

  const { logError } = require('./logger');

  async function tryChunk(chunk) {
    if (!chunk.length) return { succeeded: 0, failed: 0 };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const valueRows = chunk.map(toValues);
      await bulkInsert(client, tableSql, columns, valueRows, {
        chunkSize: Math.min(chunkSize, chunk.length),
        onConflict,
      });
      await client.query('COMMIT');
      if (onSuccess) onSuccess(chunk);
      return { succeeded: chunk.length, failed: 0 };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }

      if (chunk.length === 1) {
        logError({
          migration,
          oldId: chunk[0].id ?? chunk[0].oldId ?? chunk[0].mapKey ?? null,
          message: err.message,
          stack: err.stack,
        });
        return { succeeded: 0, failed: 1 };
      }

      const mid = Math.floor(chunk.length / 2);
      const left = await tryChunk(chunk.slice(0, mid));
      const right = await tryChunk(chunk.slice(mid));
      return {
        succeeded: left.succeeded + right.succeeded,
        failed: left.failed + right.failed,
      };
    } finally {
      client.release();
    }
  }

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += chunkSize) {
    const part = await tryChunk(items.slice(i, i + chunkSize));
    succeeded += part.succeeded;
    failed += part.failed;
  }
  return { succeeded, failed };
}

module.exports = { bulkInsert, bulkInsertWithFallback };
