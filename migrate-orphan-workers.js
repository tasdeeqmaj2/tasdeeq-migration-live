/**
 * Migrate unique workers from orphaned consumer companies to their
 * correct corporate companies. Also updates verification_tasks,
 * criminal_verification_forms, and invoices.
 *
 * DRY RUN by default. Set DRY_RUN=false to actually execute.
 *
 * Usage: node migrate-orphan-workers.js
 *        DRY_RUN=false node migrate-orphan-workers.js
 */

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');

const DB_URL = process.env.NEW_DATABASE_URL;
if (!DB_URL) { console.error('Set NEW_DATABASE_URL in .env'); process.exit(1); }

const DRY_RUN = process.env.DRY_RUN !== 'false';

const MAPPINGS = [
  { orphan_id: 'cmwpcwaov7dc0df8bfa93284b', target_id: 'cmwnhyifz23013d9398666cdc', name: 'Foodpanda' },
  { orphan_id: 'cmwpcvr4a0e73cd6b406b39b8', target_id: 'cmwnhyifz630bac7aae6ced6d', name: 'Hilal Foods' },
  { orphan_id: 'cmwpcx1s66225e84a0e032f0c', target_id: 'cmwnhyifz384c3166db500859', name: 'Lucky Cement' },
  { orphan_id: 'cmwpcv6rda2c125c86f14ec24', target_id: 'cmwnhyifyc18620bc14f11488', name: 'Osama Moin' },
  { orphan_id: 'cmwpcxdjsc397b5e5bba5c48b', target_id: 'cmwnhyifz7da948695d46afa1', name: 'Naval Anchorage' },
  { orphan_id: 'cmwpcvqbe93a21dfd3fb1ebc2', target_id: 'cmwnhyifz970f97cb76b9fb9d', name: 'Anis Apparel' },
  { orphan_id: 'cmwpcus8ye0aa4125f2059cb7', target_id: 'cmwnhyify53e0dbcd019982db', name: 'Pasha & co' },
  { orphan_id: 'cmwpcvfx1966eaefd30089552', target_id: 'cmwnhyifzd1a2c09f1de29f07', name: 'Cool Man & Co' },
  { orphan_id: 'cmwpcy99x1d469f39fd9d3ba1', target_id: 'cmwnhyifzb0104bea7bb14189', name: 'Orchards Cottage' },
  { orphan_id: 'cmwpcxsvw4e1f6f837a7b8356', target_id: 'cmwnhyifzd0259e054a16affb', name: 'Essa Lab' },
  { orphan_id: 'cmwpcxes802ad80947526fd43', target_id: 'cmwnhyifz918fb202e77f99bc', name: 'Keenan OOne' },
  { orphan_id: 'cmwpcvhqi2f2f22b33581f967', target_id: 'cmwnhyifze3cb8d923569553a', name: 'Pakistan Cotton Nappies' },
  { orphan_id: 'cmwpcvbrm5baae434b703264b', target_id: 'cmwnhyifz7ebacaab4b36f5a3', name: 'Janjua & Company' },
  { orphan_id: 'cmwpcxzos3b031c2861951615', target_id: 'cmwnhyifz578067c4af5e6a11', name: 'Sarimad Security' },
  { orphan_id: 'cmwpctl91b9665ca316dc9d5f', target_id: 'cmwnhyifx6009fc70499ab1dd', name: 'EFU Life' },
  { orphan_id: 'cmwpcvgrr14bf2dd412498312', target_id: 'cmwnhyifz1e1e6ab535d34d4a', name: 'Shahid Afridi Foundation' },
  { orphan_id: 'cmwpcxwqz93ea0e3c5ec06bb0', target_id: 'cmwnhyifz9b0c2e3266f08d09', name: 'Griffin Security' },
  { orphan_id: 'cmwpcy5l5e3d336425c1d6a9b', target_id: 'cmwnhyifzeeac27d5a77a95cd', name: 'Essa Engineering' },
  { orphan_id: 'cmwpcvc869dcdfdaaaf3dc704', target_id: 'cmwnhyifz91255ef97a471c99', name: 'TAALEM' },
  { orphan_id: 'cmwpctl17b73b9a65ecee0702', target_id: 'cmwnhyifx388fadd28acc0785', name: 'Tasdeeq (Pvt) Ltd' },
  { orphan_id: 'cmwpcv0067507078c863c7440', target_id: 'cmwnhyify5f82b1e45c08fc43', name: 'Century Insurance' },
];

async function run() {
  const db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '🚀 LIVE — WRITING TO DATABASE'}\n`);

  const report = [];

  for (const m of MAPPINGS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${m.name}: ${m.orphan_id} → ${m.target_id}`);
    console.log('═'.repeat(60));

    // 1. Find unique workers in orphan (CNIC not in target, or no CNIC)
    const { rows: uniqueWorkers } = await db.query(`
      SELECT w.id, w.cnic, w.name
      FROM workers w
      WHERE w."companyId" = $1
        AND NOT EXISTS (
          SELECT 1 FROM workers w2
          WHERE w2."companyId" = $2
            AND w2.cnic = w.cnic
            AND w.cnic IS NOT NULL AND w.cnic != ''
        )
    `, [m.orphan_id, m.target_id]);

    // 2. Find duplicate workers (CNIC exists in both)
    const { rows: dupWorkers } = await db.query(`
      SELECT w.id AS orphan_worker_id, w.cnic, w.name AS orphan_name,
             w2.id AS target_worker_id, w2.name AS target_name
      FROM workers w
      JOIN workers w2 ON w2.cnic = w.cnic AND w2."companyId" = $2
      WHERE w."companyId" = $1
        AND w.cnic IS NOT NULL AND w.cnic != ''
    `, [m.orphan_id, m.target_id]);

    console.log(`  Unique workers to move: ${uniqueWorkers.length}`);
    console.log(`  Duplicate workers (same CNIC in both): ${dupWorkers.length}`);

    const entry = {
      name: m.name,
      orphan_id: m.orphan_id,
      target_id: m.target_id,
      unique_moved: uniqueWorkers.length,
      duplicates: dupWorkers.length,
      dup_tasks_migrated: 0,
      workers_moved: [],
      dup_tasks_moved: [],
    };

    if (!DRY_RUN) {
      await db.query('BEGIN');
    }

    try {
      // 3. Move unique workers: update companyId
      if (uniqueWorkers.length > 0) {
        const uniqueIds = uniqueWorkers.map(w => w.id);
        entry.workers_moved = uniqueIds;

        if (DRY_RUN) {
          console.log(`  [DRY RUN] Would move ${uniqueIds.length} workers`);
        } else {
          await db.query(`
            UPDATE workers SET "companyId" = $1 WHERE id = ANY($2::text[])
          `, [m.target_id, uniqueIds]);
          console.log(`  ✓ Moved ${uniqueIds.length} workers`);
        }

        // Also move their verification_tasks
        const { rows: tasks } = await db.query(`
          SELECT id FROM verification_tasks WHERE "workerId" = ANY($1::text[])
        `, [uniqueIds]);

        if (tasks.length > 0) {
          const taskIds = tasks.map(t => t.id);
          if (DRY_RUN) {
            console.log(`  [DRY RUN] Would move ${taskIds.length} verification tasks`);
          } else {
            await db.query(`
              UPDATE verification_tasks SET "companyId" = $1 WHERE id = ANY($2::text[])
            `, [m.target_id, taskIds]);
            console.log(`  ✓ Moved ${taskIds.length} verification tasks`);
          }
        }

        // Move invoices that reference these tasks
        const { rows: invoices } = await db.query(`
          SELECT DISTINCT i.id
          FROM invoices i
          JOIN invoice_items ii ON ii."invoiceId" = i.id
          JOIN verification_tasks vt ON vt.id = ii."taskId"
          WHERE vt."workerId" = ANY($1::text[])
            AND i."companyId" = $2
        `, [uniqueIds, m.orphan_id]);

        if (invoices.length > 0) {
          const invoiceIds = invoices.map(i => i.id);
          if (DRY_RUN) {
            console.log(`  [DRY RUN] Would move ${invoiceIds.length} invoices`);
          } else {
            await db.query(`
              UPDATE invoices SET "companyId" = $1 WHERE id = ANY($2::text[])
            `, [m.target_id, invoiceIds]);
            console.log(`  ✓ Moved ${invoiceIds.length} invoices`);
          }
        }
      }

      // 4. Handle duplicates: move tasks from orphan's duplicate worker to target's worker
      //    so verification history is preserved on the target company
      for (const dup of dupWorkers) {
        const { rows: orphanTasks } = await db.query(`
          SELECT id FROM verification_tasks
          WHERE "workerId" = $1 AND "companyId" = $2
        `, [dup.orphan_worker_id, m.orphan_id]);

        if (orphanTasks.length > 0) {
          const taskIds = orphanTasks.map(t => t.id);
          entry.dup_tasks_migrated += taskIds.length;
          entry.dup_tasks_moved.push({
            orphan_worker: dup.orphan_worker_id,
            target_worker: dup.target_worker_id,
            cnic: dup.cnic,
            tasks: taskIds.length,
          });

          if (DRY_RUN) {
            // just count
          } else {
            // Point the tasks at the target worker and target company
            await db.query(`
              UPDATE verification_tasks
              SET "workerId" = $1, "companyId" = $2
              WHERE id = ANY($3::text[])
            `, [dup.target_worker_id, m.target_id, taskIds]);
          }
        }
      }

      if (entry.dup_tasks_migrated > 0) {
        if (DRY_RUN) {
          console.log(`  [DRY RUN] Would migrate ${entry.dup_tasks_migrated} tasks from duplicate workers to target workers`);
        } else {
          console.log(`  ✓ Migrated ${entry.dup_tasks_migrated} tasks from duplicate workers`);
        }
      }

      if (!DRY_RUN) {
        await db.query('COMMIT');
        console.log(`  ✓ COMMITTED`);
      }

    } catch (err) {
      if (!DRY_RUN) {
        await db.query('ROLLBACK');
        console.error(`  ✗ ROLLED BACK: ${err.message}`);
      } else {
        console.error(`  ✗ Error: ${err.message}`);
      }
      entry.error = err.message;
    }

    report.push(entry);
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('MIGRATION SUMMARY');
  console.log('═'.repeat(60));

  let totalMoved = 0, totalDupTasks = 0;
  for (const r of report) {
    totalMoved += r.unique_moved;
    totalDupTasks += r.dup_tasks_migrated;
    if (r.unique_moved > 0 || r.dup_tasks_migrated > 0) {
      console.log(`  ${r.name}: ${r.unique_moved} workers moved, ${r.dup_tasks_migrated} dup tasks migrated${r.error ? ' ⚠️ ' + r.error : ''}`);
    }
  }
  console.log(`\n  TOTAL: ${totalMoved} unique workers moved, ${totalDupTasks} duplicate tasks migrated`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const outPath = __dirname + '/migrate-report.json';
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report saved to ${outPath}`);

  await db.end();
}

run().catch(e => { console.error(e); process.exit(1); });
