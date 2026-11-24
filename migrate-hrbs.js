/**
 * Migrate workers (+ tasks, invoices, forms) from the orphan company to HR Business Solutions.
 *
 * Orphan:  cmwpe0mure1572a69a2270b20  ("Umair Shamim", isConsumer, 432 workers)
 * Target:  cmwnhyihg639a0e91da02f2c7  (HR Business Solutions)
 * Old user: 407063
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
if (!NEW_DB_URL) { console.error('Set NEW_DATABASE_URL in .env'); process.exit(1); }
const SSL = { rejectUnauthorized: false };

const DRY_RUN = process.env.DRY_RUN !== 'false';
const ORPHAN_ID = 'cmwpe0mure1572a69a2270b20';
const TARGET_ID = 'cmwnhyihg639a0e91da02f2c7';

async function run() {
  const db = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  await db.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);
  console.log(`Orphan: ${ORPHAN_ID}`);
  console.log(`Target: ${TARGET_ID}\n`);

  // 1. Verify both companies exist
  const { rows: [orphan] } = await db.query(
    `SELECT id, name, "isConsumer" FROM companies WHERE id = $1`, [ORPHAN_ID]
  );
  const { rows: [target] } = await db.query(
    `SELECT id, name, "isConsumer" FROM companies WHERE id = $1`, [TARGET_ID]
  );
  if (!orphan) { console.error('Orphan company not found!'); process.exit(1); }
  if (!target) { console.error('Target company not found!'); process.exit(1); }
  console.log(`Orphan: "${orphan.name}" (isConsumer=${orphan.isConsumer})`);
  console.log(`Target: "${target.name}" (isConsumer=${target.isConsumer})\n`);

  // 2. Count what we're moving
  const { rows: [{ cnt: workerCount }] } = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM workers WHERE "companyId" = $1`, [ORPHAN_ID]
  );
  const { rows: [{ cnt: taskCount }] } = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM verification_tasks WHERE "companyId" = $1`, [ORPHAN_ID]
  );
  const { rows: [{ cnt: invoiceCount }] } = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM invoices WHERE "companyId" = $1`, [ORPHAN_ID]
  );
  const { rows: [{ cnt: formCount }] } = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM criminal_verification_forms cf
     JOIN verification_tasks vt ON vt.id = cf."taskId"
     WHERE vt."companyId" = $1`, [ORPHAN_ID]
  );

  console.log(`Workers to move:  ${workerCount}`);
  console.log(`Tasks to move:    ${taskCount}`);
  console.log(`Forms attached:   ${formCount}`);
  console.log(`Invoices to move: ${invoiceCount}\n`);

  if (!DRY_RUN) {
    await db.query('BEGIN');
    try {
      // Move workers
      const r1 = await db.query(
        `UPDATE workers SET "companyId" = $1 WHERE "companyId" = $2`, [TARGET_ID, ORPHAN_ID]
      );
      console.log(`✓ Workers moved: ${r1.rowCount}`);

      // Move tasks
      const r2 = await db.query(
        `UPDATE verification_tasks SET "companyId" = $1 WHERE "companyId" = $2`, [TARGET_ID, ORPHAN_ID]
      );
      console.log(`✓ Tasks moved: ${r2.rowCount}`);

      // Move invoices
      const r3 = await db.query(
        `UPDATE invoices SET "companyId" = $1 WHERE "companyId" = $2`, [TARGET_ID, ORPHAN_ID]
      );
      console.log(`✓ Invoices moved: ${r3.rowCount}`);

      // Move worker_activities if any
      const r5 = await db.query(
        `UPDATE worker_activities SET "companyId" = $1 WHERE "companyId" = $2`, [TARGET_ID, ORPHAN_ID]
      );
      if (r5.rowCount > 0) console.log(`✓ Worker activities moved: ${r5.rowCount}`);

      await db.query('COMMIT');
      console.log('\n✓ All changes committed.');
    } catch (err) {
      await db.query('ROLLBACK');
      console.error(`\n✗ ROLLBACK: ${err.message}`);
    }
  } else {
    console.log('[DRY RUN] No changes made.');
  }

  // Verify after migration
  if (!DRY_RUN) {
    const { rows: [{ cnt: remaining }] } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM workers WHERE "companyId" = $1`, [ORPHAN_ID]
    );
    const { rows: [{ cnt: targetWorkers }] } = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM workers WHERE "companyId" = $1`, [TARGET_ID]
    );
    console.log(`\nVerification:`);
    console.log(`  Orphan workers remaining: ${remaining}`);
    console.log(`  Target workers total:     ${targetWorkers}`);
  }

  await db.end();
}
run().catch(e => { console.error(e); process.exit(1); });
