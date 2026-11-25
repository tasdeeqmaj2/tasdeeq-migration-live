/**
 * Create "migration settlement" invoices for all migrated COMPLETED tasks
 * that have no invoiceId. These tasks were already paid in the old system
 * but appear as outstanding in the new system's credit calculation.
 *
 * For each company with such tasks, creates one APPROVED/POSTPAID invoice
 * at 500 PKR per task, links all tasks + creates invoice_items.
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 *
 * Usage:
 *   node create-migration-invoices.js                    # dry run, local docker DB
 *   node create-migration-invoices.js --prod             # dry run, production
 *   DRY_RUN=false node create-migration-invoices.js      # live, local
 *   DRY_RUN=false node create-migration-invoices.js --prod  # live, production
 */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const PROD = process.argv.includes('--prod');
const DRY_RUN = process.env.DRY_RUN !== 'false';

const DB_URL = PROD
  ? process.env.NEW_DATABASE_URL
  : process.env.DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';

if (!DB_URL) { console.error('Set NEW_DATABASE_URL (--prod) or DATABASE_URL in .env'); process.exit(1); }

const SSL = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
const UNIT_PRICE = 500;

function cuid() {
  // Simple cuid-like id generator
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  return 'c' + timestamp + random;
}

async function run() {
  const db = new Client({ connectionString: DB_URL, ssl: SSL });
  await db.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}  ${PROD ? '[PRODUCTION]' : '[LOCAL]'}\n`);

  // Find all companies with COMPLETED tasks that have no invoice
  const { rows: companies } = await db.query(`
    SELECT vt."companyId", c.name, COUNT(*)::int AS task_count
    FROM verification_tasks vt
    JOIN companies c ON c.id = vt."companyId"
    WHERE vt.status = 'COMPLETED'
      AND vt."invoiceId" IS NULL
    GROUP BY vt."companyId", c.name
    ORDER BY task_count DESC
  `);

  console.log(`Companies with uninvoiced COMPLETED tasks: ${companies.length}\n`);

  if (companies.length === 0) {
    console.log('Nothing to do.');
    await db.end();
    return;
  }

  // Get the highest existing invoice number to continue the sequence
  const { rows: [lastInv] } = await db.query(`
    SELECT "invoiceNumber" FROM invoices
    ORDER BY "createdAt" DESC LIMIT 1
  `);
  console.log(`Last invoice number: ${lastInv?.invoiceNumber || 'none'}\n`);

  // Find a super_admin user to use as createdById
  const { rows: [admin] } = await db.query(`
    SELECT id FROM users WHERE role = 'super_admin' LIMIT 1
  `);
  if (!admin) {
    console.error('No super_admin user found');
    await db.end();
    return;
  }

  // Bank details snapshot for migration invoices
  const bankSnapshot = JSON.stringify({
    note: 'Migration settlement — tasks paid in legacy system',
  });

  let totalInvoices = 0;
  let totalTasks = 0;
  let totalAmount = 0;

  // Use MIG-YYYY prefix for migration invoices
  const migPrefix = 'MIG-2024';

  if (!DRY_RUN) await db.query('BEGIN');

  try {
    for (let i = 0; i < companies.length; i++) {
      const comp = companies[i];
      const invoiceNumber = `${migPrefix}-${String(i + 1).padStart(4, '0')}`;
      const invoiceId = cuid();
      const amount = comp.task_count * UNIT_PRICE;

      // Get the actual task IDs
      const { rows: tasks } = await db.query(`
        SELECT id FROM verification_tasks
        WHERE "companyId" = $1 AND status = 'COMPLETED' AND "invoiceId" IS NULL
      `, [comp.companyId]);

      if (tasks.length === 0) continue;

      console.log(`${DRY_RUN ? '[DRY] ' : ''}${comp.name}: ${tasks.length} tasks → ${invoiceNumber} (${amount.toLocaleString()} PKR)`);

      if (!DRY_RUN) {
        const now = new Date().toISOString();

        // Create the invoice (APPROVED status, POSTPAID)
        await db.query(`
          INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
                                "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById",
                                "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, 'APPROVED', 'POSTPAID', $5, $6::jsonb, $7, $4, $7, $7)
        `, [invoiceId, invoiceNumber, comp.companyId, admin.id, amount, bankSnapshot, now]);

        // Create invoice_items for each task
        for (const task of tasks) {
          const itemId = cuid();
          await db.query(`
            INSERT INTO invoice_items (id, "invoiceId", "taskId", "unitPrice", "createdAt")
            VALUES ($1, $2, $3, $4, $5)
          `, [itemId, invoiceId, task.id, UNIT_PRICE, now]);
        }

        // Link tasks to the invoice
        const taskIds = tasks.map(t => t.id);
        await db.query(`
          UPDATE verification_tasks SET "invoiceId" = $1
          WHERE id = ANY($2::text[])
        `, [invoiceId, taskIds]);
      }

      totalInvoices++;
      totalTasks += tasks.length;
      totalAmount += amount;
    }

    if (!DRY_RUN) {
      await db.query('COMMIT');
      console.log('\n✓ Committed.');
    }
  } catch (err) {
    if (!DRY_RUN) await db.query('ROLLBACK');
    console.error(`\n✗ ROLLBACK: ${err.message}`);
    await db.end();
    return;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Invoices created: ${totalInvoices}`);
  console.log(`  Tasks linked: ${totalTasks}`);
  console.log(`  Total amount: ${totalAmount.toLocaleString()} PKR`);

  if (!DRY_RUN) {
    // Verify
    const { rows: [verify] } = await db.query(`
      SELECT COUNT(*)::int AS cnt
      FROM verification_tasks
      WHERE status = 'COMPLETED' AND "invoiceId" IS NULL
    `);
    console.log(`\n  Remaining uninvoiced COMPLETED tasks: ${verify.cnt}`);
  }

  await db.end();
}
run().catch(e => { console.error(e); process.exit(1); });
