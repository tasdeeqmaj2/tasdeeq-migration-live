/**
 * Remove duplicate workers created by the encrypted-email migration.
 * A worker is a duplicate if another worker with the same CNIC exists
 * in the same company and was NOT inserted by our migration.
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
const NEW_DB_URL = process.env.NEW_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
const BATCH_SIZE = 5000;

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  await newDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);

  // Load encrypted worker map
  const encMapPath = path.join(__dirname, 'mappings', 'encryptedWorkerMap.json');
  const encMap = JSON.parse(fs.readFileSync(encMapPath, 'utf8'));
  const encWorkerIds = Object.values(encMap);
  console.log(`Encrypted migration workers: ${encWorkerIds.length}\n`);

  // Find duplicates in batches
  const duplicateIds = [];
  const keepIds = [];

  for (let i = 0; i < encWorkerIds.length; i += BATCH_SIZE) {
    const batch = encWorkerIds.slice(i, i + BATCH_SIZE);
    const { rows } = await newDb.query(`
      SELECT w1.id AS enc_id
      FROM workers w1
      WHERE w1.id = ANY($1::text[])
        AND EXISTS (
          SELECT 1 FROM workers w2
          WHERE w2."companyId" = w1."companyId"
            AND w2.cnic = w1.cnic
            AND w2.id != w1.id
            AND w2.id != ALL($1::text[])
        )
    `, [batch]);

    const dupSet = new Set(rows.map(r => r.enc_id));
    for (const id of batch) {
      if (dupSet.has(id)) {
        duplicateIds.push(id);
      } else {
        keepIds.push(id);
      }
    }

    if ((i / BATCH_SIZE) % 10 === 0) {
      console.log(`  Scanned ${Math.min(i + BATCH_SIZE, encWorkerIds.length)}/${encWorkerIds.length}...`);
    }
  }

  console.log(`\nDuplicates to delete: ${duplicateIds.length}`);
  console.log(`Unique to keep: ${keepIds.length}\n`);

  if (duplicateIds.length === 0) {
    console.log('Nothing to clean up.');
    await newDb.end();
    return;
  }

  if (!DRY_RUN) {
    await newDb.query('BEGIN');
    try {
      // Delete documents first (FK constraint)
      let docsDeleted = 0;
      for (let i = 0; i < duplicateIds.length; i += BATCH_SIZE) {
        const batch = duplicateIds.slice(i, i + BATCH_SIZE);
        const { rowCount } = await newDb.query(
          `DELETE FROM worker_documents WHERE "workerId" = ANY($1::text[])`,
          [batch]
        );
        docsDeleted += rowCount;
        if ((i / BATCH_SIZE) % 5 === 0) {
          console.log(`  Deleted docs batch ${Math.floor(i / BATCH_SIZE) + 1}... (${docsDeleted} total)`);
        }
      }
      console.log(`Deleted ${docsDeleted} duplicate documents`);

      // Delete duplicate workers
      let workersDeleted = 0;
      for (let i = 0; i < duplicateIds.length; i += BATCH_SIZE) {
        const batch = duplicateIds.slice(i, i + BATCH_SIZE);
        const { rowCount } = await newDb.query(
          `DELETE FROM workers WHERE id = ANY($1::text[])`,
          [batch]
        );
        workersDeleted += rowCount;
        if ((i / BATCH_SIZE) % 5 === 0) {
          console.log(`  Deleted workers batch ${Math.floor(i / BATCH_SIZE) + 1}... (${workersDeleted} total)`);
        }
      }
      console.log(`Deleted ${workersDeleted} duplicate workers`);

      await newDb.query('COMMIT');
      console.log('\n✓ Committed.');

      // Update encryptedWorkerMap — remove deleted entries
      const dupSet = new Set(duplicateIds);
      const cleanedMap = {};
      for (const [empId, workerId] of Object.entries(encMap)) {
        if (!dupSet.has(workerId)) {
          cleanedMap[empId] = workerId;
        }
      }
      const mapPath = path.join(__dirname, 'mappings', 'encryptedWorkerMap.json');
      const tmp = `${mapPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cleanedMap), 'utf8');
      fs.renameSync(tmp, mapPath);
      console.log(`Updated encryptedWorkerMap: ${Object.keys(cleanedMap).length} entries (removed ${Object.keys(encMap).length - Object.keys(cleanedMap).length})`);

    } catch (err) {
      await newDb.query('ROLLBACK');
      console.error(`\n✗ ROLLBACK: ${err.message}`);
      console.error(err.stack);
    }
  } else {
    console.log(`[DRY] Would delete ${duplicateIds.length} duplicate workers + their documents`);
    console.log(`[DRY] Would keep ${keepIds.length} unique workers`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Total encrypted-migration workers: ${encWorkerIds.length}`);
  console.log(`  Duplicates deleted: ${duplicateIds.length}`);
  console.log(`  Unique kept: ${keepIds.length}`);

  await newDb.end();
}

run().catch(e => { console.error(e); process.exit(1); });
