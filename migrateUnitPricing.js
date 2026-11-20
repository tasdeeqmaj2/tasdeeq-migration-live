/**
 * Migrate historical unit pricing from old DB to new DB.
 *
 * For each company's paid verifications, looks up the verification_ledger
 * type 4 (Paid Verification) entries to find the actual amount paid, then
 * creates Invoice + InvoiceItem rows in the new DB with the correct unitPrice.
 *
 * Also handles free verifications (type 3/5) with unitPrice = 0.
 *
 * Approach: for each old user (now a company), chronologically match their
 * type 4 ledger entries with their employments to determine per-verification price.
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

async function main() {
  section('Migrate historical unit pricing → Invoice + InvoiceItem');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap(USER_MAP_NAME);  // oldUserId → newCompanyId
  const taskMap = loadMap(TASK_MAP_NAME);      // oldEmploymentId → newTaskId

  // Build reverse maps
  const reverseTaskMap = {};  // newTaskId → oldEmploymentId
  for (const [oldId, newId] of Object.entries(taskMap)) {
    reverseTaskMap[newId] = oldId;
  }

  // Check how many tasks already have invoices (skip those)
  const { rows: [{ cnt: alreadyInvoiced }] } = await newDb.query(`
    SELECT COUNT(*)::int AS cnt FROM verification_tasks WHERE "invoiceId" IS NOT NULL
  `);
  info(`Tasks already with invoiceId: ${alreadyInvoiced}`);

  // Get all tasks without invoices that were migrated (have an old employment mapping)
  const { rows: tasksWithoutInvoice } = await newDb.query(`
    SELECT vt.id AS "taskId", vt."companyId", vt."createdAt"
    FROM verification_tasks vt
    WHERE vt."invoiceId" IS NULL
    ORDER BY vt."companyId", vt."createdAt"
  `);
  info(`Tasks without invoice: ${tasksWithoutInvoice.length}`);

  // Group tasks by company
  const tasksByCompany = {};
  for (const t of tasksWithoutInvoice) {
    if (!tasksByCompany[t.companyId]) tasksByCompany[t.companyId] = [];
    tasksByCompany[t.companyId].push(t);
  }

  const companyIds = Object.keys(tasksByCompany);
  info(`Companies with uninvoiced tasks: ${companyIds.length}`);

  // Build reverse companyMap: newCompanyId → oldUserId
  const reverseCompanyMap = {};
  for (const [oldUserId, newCompanyId] of Object.entries(companyMap)) {
    reverseCompanyMap[newCompanyId] = oldUserId;
  }

  // Get bank details snapshot (use a default since these are historical)
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
  let companiesSkipped = 0;
  let noOldUser = 0;

  for (const companyId of companyIds) {
    const tasks = tasksByCompany[companyId];
    const oldUserId = reverseCompanyMap[companyId];

    if (!oldUserId) {
      // Company wasn't migrated from old DB (e.g. created in new system)
      noOldUser++;
      continue;
    }

    // Get this user's paid verification ledger entries (type 4), ordered by date
    const { rows: paidEntries } = await oldDb.query(`
      SELECT id, quantity, amount, date
      FROM verification_ledger
      WHERE user_id = $1 AND transaction_type_id = 4
      ORDER BY date ASC, id ASC
    `, [Number(oldUserId)]);

    // Get this user's free verification entries (type 3 and 5)
    const { rows: freeEntries } = await oldDb.query(`
      SELECT id, quantity, amount, date
      FROM verification_ledger
      WHERE user_id = $1 AND transaction_type_id IN (3, 5)
      ORDER BY date ASC, id ASC
    `, [Number(oldUserId)]);

    // Get the user's employments ordered by date to match with ledger entries
    const { rows: oldEmployments } = await oldDb.query(`
      SELECT id, created_at
      FROM user_worker_employment
      WHERE user_id = $1
      ORDER BY created_at ASC, id ASC
    `, [Number(oldUserId)]);

    // Build a map: oldEmploymentId → price from ledger
    const empPriceMap = new Map();

    // Merge paid and free into one timeline
    const allConsumptions = [];
    for (const p of paidEntries) {
      const qty = Math.abs(Number(p.quantity) || 1);
      const amt = Math.abs(Number(p.amount) || 0);
      const unitPrice = qty > 0 ? Math.round(amt / qty) : amt;
      for (let i = 0; i < qty; i++) {
        allConsumptions.push({ date: new Date(p.date), unitPrice, type: 'paid' });
      }
    }
    for (const f of freeEntries) {
      const qty = Math.abs(Number(f.quantity) || 1);
      for (let i = 0; i < qty; i++) {
        allConsumptions.push({ date: new Date(f.date), unitPrice: 0, type: 'free' });
      }
    }
    allConsumptions.sort((a, b) => a.date - b.date);

    // Sort employments by date
    const sortedEmps = oldEmployments.map(e => ({
      id: Number(e.id),
      date: new Date(e.created_at),
    })).sort((a, b) => a.date - b.date || a.id - b.id);

    // Zip: assign prices to employments in chronological order
    for (let i = 0; i < sortedEmps.length && i < allConsumptions.length; i++) {
      empPriceMap.set(sortedEmps[i].id, allConsumptions[i].unitPrice);
    }

    // Now create invoice for this company's tasks
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
    const invoiceNumber = `MIG-${oldUserId}-${Date.now().toString(36)}`;

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

        // Link tasks to invoice
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
