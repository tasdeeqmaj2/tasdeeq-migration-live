/**
 * Migrate historical unit pricing from old DB to new DB.
 *
 * ONLY processes tasks that exist in the taskMap (migrated from old system).
 * Tasks created natively in the new system are left untouched.
 *
 * Step 1: Roll back any MIG- invoices from a previous bad run
 * Step 2: For each migrated task, look up the price from verification_ledger
 * Step 3: Create Invoice + InvoiceItem with the correct historical unitPrice
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { section, info, success, warn, logError, flushErrors } = require('./utils/logger');

const SYSTEM_USER_ID = 'cmwnhyial8dec1ccd12b0c75a';
const USER_MAP_NAME = 'companyMap.json';
const TASK_MAP_NAME = 'verificationTaskMap.json';
const BATCH = 200;

function generateCuid() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return 'c' + ts + rand + Math.random().toString(36).slice(2, 6);
}

function parseOldUserId(raw) {
  if (!raw) return null;
  // Handle hh-12345 prefix format
  const stripped = String(raw).replace(/^hh-/, '');
  const num = Number(stripped);
  return isNaN(num) ? null : num;
}

async function main() {
  section('Migrate historical unit pricing → Invoice + InvoiceItem');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap(USER_MAP_NAME);  // oldUserId → newCompanyId
  const taskMap = loadMap(TASK_MAP_NAME);      // oldEmploymentId → newTaskId

  // ── Step 1: Roll back previous bad MIG- invoices ──
  section('Step 1: Rolling back previous MIG- invoices');

  const { rows: [{ cnt: migInvoiceCount }] } = await newDb.query(`
    SELECT COUNT(*)::int AS cnt FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%'
  `);
  info(`Found ${migInvoiceCount} MIG- invoices to roll back`);

  if (migInvoiceCount > 0) {
    // Unlink tasks from MIG invoices
    await newDb.query(`
      UPDATE verification_tasks SET "invoiceId" = NULL
      WHERE "invoiceId" IN (SELECT id FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%')
    `);
    // Delete invoice items
    await newDb.query(`
      DELETE FROM invoice_items
      WHERE "invoiceId" IN (SELECT id FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%')
    `);
    // Delete invoices
    const { rowCount } = await newDb.query(`
      DELETE FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%'
    `);
    success(`Rolled back ${rowCount} MIG- invoices`);
  }

  // ── Step 2: Build the set of migrated tasks only ──
  section('Step 2: Building migrated task set');

  // reverseTaskMap: newTaskId → oldEmploymentId
  const reverseTaskMap = {};
  for (const [oldId, newId] of Object.entries(taskMap)) {
    reverseTaskMap[newId] = oldId;
  }
  const migratedTaskIds = Object.values(taskMap); // all new task IDs from migration
  info(`Migrated tasks in taskMap: ${migratedTaskIds.length}`);

  // reverseCompanyMap: newCompanyId → oldUserId (parsed numeric)
  const reverseCompanyMap = {};
  for (const [oldUserId, newCompanyId] of Object.entries(companyMap)) {
    reverseCompanyMap[newCompanyId] = oldUserId;
  }

  // Load migrated tasks from DB (only those in taskMap and without invoice)
  // Process in chunks to avoid loading all task IDs into one query
  const migratedTasks = [];
  for (let i = 0; i < migratedTaskIds.length; i += 5000) {
    const chunk = migratedTaskIds.slice(i, i + 5000);
    const { rows } = await newDb.query(`
      SELECT id AS "taskId", "companyId", "createdAt"
      FROM verification_tasks
      WHERE id = ANY($1::text[]) AND "invoiceId" IS NULL
    `, [chunk]);
    migratedTasks.push(...rows);
  }
  info(`Migrated tasks without invoice: ${migratedTasks.length}`);

  // Group by company
  const tasksByCompany = {};
  for (const t of migratedTasks) {
    if (!tasksByCompany[t.companyId]) tasksByCompany[t.companyId] = [];
    tasksByCompany[t.companyId].push(t);
  }

  const companyIds = Object.keys(tasksByCompany);
  info(`Companies with migrated uninvoiced tasks: ${companyIds.length}`);

  // ── Step 3: Create invoices ──
  section('Step 3: Creating invoices with historical pricing');

  const defaultBankSnapshot = JSON.stringify({
    bankName: 'Historical Migration',
    accountTitle: 'N/A',
    accountNumber: 'N/A',
    note: 'Auto-created during migration for historical pricing records',
  });

  let invoicesCreated = 0;
  let itemsCreated = 0;
  let tasksLinked = 0;
  let companiesProcessed = 0;
  let noOldUser = 0;
  let noLedgerData = 0;

  for (const companyId of companyIds) {
    const tasks = tasksByCompany[companyId];
    const rawOldUserId = reverseCompanyMap[companyId];
    const oldUserId = parseOldUserId(rawOldUserId);

    if (oldUserId === null) {
      noOldUser++;
      continue;
    }

    // Get this user's paid verification ledger entries (type 4)
    const { rows: paidEntries } = await oldDb.query(`
      SELECT id, quantity, amount, date
      FROM verification_ledger
      WHERE user_id = $1 AND transaction_type_id = 4
      ORDER BY date ASC, id ASC
    `, [oldUserId]);

    // Get free verification entries (type 3 and 5)
    const { rows: freeEntries } = await oldDb.query(`
      SELECT id, quantity, amount, date
      FROM verification_ledger
      WHERE user_id = $1 AND transaction_type_id IN (3, 5)
      ORDER BY date ASC, id ASC
    `, [oldUserId]);

    // Get employments ordered by registration date
    const { rows: oldEmployments } = await oldDb.query(`
      SELECT id, registration_timestamp
      FROM user_worker_employment
      WHERE user_id = $1
      ORDER BY registration_timestamp ASC, id ASC
    `, [oldUserId]);

    // Merge paid and free consumptions into one timeline
    const allConsumptions = [];
    for (const p of paidEntries) {
      const qty = Math.abs(Number(p.quantity) || 1);
      const amt = Math.abs(Number(p.amount) || 0);
      const unitPrice = qty > 0 ? Math.round(amt / qty) : amt;
      for (let i = 0; i < qty; i++) {
        allConsumptions.push({ date: new Date(p.date), unitPrice });
      }
    }
    for (const f of freeEntries) {
      const qty = Math.abs(Number(f.quantity) || 1);
      for (let i = 0; i < qty; i++) {
        allConsumptions.push({ date: new Date(f.date), unitPrice: 0 });
      }
    }
    allConsumptions.sort((a, b) => a.date - b.date);

    // Sort employments by date
    const sortedEmps = oldEmployments.map(e => ({
      id: Number(e.id),
      date: new Date(e.registration_timestamp),
    })).sort((a, b) => a.date - b.date || a.id - b.id);

    // Zip: assign prices to employments in chronological order
    const empPriceMap = new Map();
    for (let i = 0; i < sortedEmps.length && i < allConsumptions.length; i++) {
      empPriceMap.set(sortedEmps[i].id, allConsumptions[i].unitPrice);
    }

    // Build task prices (only migrated tasks)
    const taskPrices = [];
    let totalAmount = 0;

    for (const task of tasks) {
      const oldEmpId = reverseTaskMap[task.taskId];
      let unitPrice = 0;

      if (oldEmpId) {
        unitPrice = empPriceMap.get(Number(oldEmpId)) ?? 0;
      }

      taskPrices.push({ taskId: task.taskId, unitPrice });
      totalAmount += unitPrice;
    }

    if (taskPrices.length === 0) continue;

    // Create one invoice per company
    const invoiceId = generateCuid();
    const invoiceNumber = `MIG-${rawOldUserId || companyId}-${Date.now().toString(36)}`;

    await newDb.query(`
      INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
        "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, 'APPROVED', 'PREPAID', $5, $6, NOW(), $7, NOW(), NOW())
    `, [invoiceId, invoiceNumber, companyId, SYSTEM_USER_ID, totalAmount, defaultBankSnapshot, SYSTEM_USER_ID]);
    invoicesCreated++;

    // Create invoice items and link tasks in batches
    for (let i = 0; i < taskPrices.length; i += BATCH) {
      const batch = taskPrices.slice(i, i + BATCH);

      const itemValues = [];
      const itemParams = [];
      let paramIdx = 1;

      for (const tp of batch) {
        const itemId = generateCuid();
        itemValues.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NOW())`);
        itemParams.push(itemId, invoiceId, tp.taskId, tp.unitPrice);
      }

      if (itemValues.length > 0) {
        await newDb.query(`
          INSERT INTO invoice_items (id, "invoiceId", "taskId", "unitPrice", "createdAt")
          VALUES ${itemValues.join(', ')}
          ON CONFLICT ("taskId") DO NOTHING
        `, itemParams);

        const taskIds = batch.map(b => b.taskId);
        await newDb.query(`
          UPDATE verification_tasks SET "invoiceId" = $1 WHERE id = ANY($2::text[]) AND "invoiceId" IS NULL
        `, [invoiceId, taskIds]);

        itemsCreated += batch.length;
        tasksLinked += batch.length;
      }
    }

    companiesProcessed++;
    if (companiesProcessed % 100 === 0) {
      info(`  Progress: ${companiesProcessed}/${companyIds.length} companies, ${invoicesCreated} invoices, ${itemsCreated} items`);
    }
  }

  flushErrors();
  success(`Done!
  Companies processed: ${companiesProcessed}
  Companies skipped (no old user): ${noOldUser}
  Invoices created: ${invoicesCreated}
  Invoice items created: ${itemsCreated}
  Tasks linked: ${tasksLinked}`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
