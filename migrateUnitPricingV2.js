/**
 * Migrate historical unit pricing v2 — uses worker_purchase_invoice directly.
 *
 * Creates one MIG- invoice per worker_purchase_invoice row (18k rows),
 * assigns tasks by chronological order within each company.
 *
 * Much faster than v1 since it processes ~18k invoice rows, not 75k companies.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { section, info, success, warn, flushErrors } = require('./utils/logger');

const SYSTEM_USER_ID = 'cmwnhyial8dec1ccd12b0c75a';
const USER_MAP_NAME = 'companyMap.json';
const TASK_MAP_NAME = 'verificationTaskMap.json';
const BATCH = 500;

function generateCuid() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return 'c' + ts + rand + Math.random().toString(36).slice(2, 6);
}

function parseOldUserId(raw) {
  if (!raw) return null;
  const stripped = String(raw).replace(/^hh-/, '');
  const num = Number(stripped);
  return isNaN(num) ? null : num;
}

async function main() {
  section('Migrate historical unit pricing v2 → worker_purchase_invoice');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap(USER_MAP_NAME);  // oldUserId → newCompanyId
  const taskMap = loadMap(TASK_MAP_NAME);      // oldEmploymentId → newTaskId

  // ── Step 1: Roll back previous MIG- invoices ──
  section('Step 1: Rolling back previous MIG- invoices');

  const { rows: [{ cnt: migInvoiceCount }] } = await newDb.query(`
    SELECT COUNT(*)::int AS cnt FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%'
  `);
  info(`Found ${migInvoiceCount} MIG- invoices to roll back`);

  if (migInvoiceCount > 0) {
    await newDb.query(`
      UPDATE verification_tasks SET "invoiceId" = NULL
      WHERE "invoiceId" IN (SELECT id FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%')
    `);
    await newDb.query(`
      DELETE FROM invoice_items
      WHERE "invoiceId" IN (SELECT id FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%')
    `);
    const { rowCount } = await newDb.query(`
      DELETE FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%'
    `);
    success(`Rolled back ${rowCount} MIG- invoices`);
  }

  // ── Step 2: Load all old invoices ──
  section('Step 2: Loading worker_purchase_invoice from old DB');

  // Query explicitly from public schema to avoid search_path issues
  const { rows: oldInvoices } = await oldDb.query(`
    SELECT id, user_id, invoice_number, amount, worker_count, date, payment_status, status
    FROM public.worker_purchase_invoice
    WHERE is_active = true
    ORDER BY user_id, date ASC, id ASC
  `);
  info(`Old invoices loaded: ${oldInvoices.length}`);

  // Build reverse maps
  const reverseCompanyMap = {}; // newCompanyId → oldUserId (string)
  const oldUserToCompany = {};  // oldUserId (number) → newCompanyId
  for (const [oldUserId, newCompanyId] of Object.entries(companyMap)) {
    const parsed = parseOldUserId(oldUserId);
    if (parsed !== null) {
      reverseCompanyMap[newCompanyId] = oldUserId;
      oldUserToCompany[parsed] = newCompanyId;
    }
  }

  // reverseTaskMap: newTaskId → oldEmploymentId (number)
  const reverseTaskMap = {};
  for (const [oldId, newId] of Object.entries(taskMap)) {
    reverseTaskMap[newId] = Number(oldId);
  }

  // ── Step 3: Load migrated tasks grouped by company ──
  section('Step 3: Loading migrated tasks');

  const migratedTaskIds = Object.values(taskMap);
  info(`Total migrated task IDs: ${migratedTaskIds.length}`);

  // Load tasks in chunks
  const tasksByCompany = {};
  for (let i = 0; i < migratedTaskIds.length; i += 5000) {
    const chunk = migratedTaskIds.slice(i, i + 5000);
    const { rows } = await newDb.query(`
      SELECT id AS "taskId", "companyId", "createdAt"
      FROM verification_tasks
      WHERE id = ANY($1::text[]) AND "invoiceId" IS NULL
    `, [chunk]);
    for (const t of rows) {
      if (!tasksByCompany[t.companyId]) tasksByCompany[t.companyId] = [];
      tasksByCompany[t.companyId].push(t);
    }
  }

  // Sort each company's tasks by createdAt
  for (const companyId of Object.keys(tasksByCompany)) {
    tasksByCompany[companyId].sort((a, b) =>
      new Date(a.createdAt) - new Date(b.createdAt)
    );
  }

  const companiesWithTasks = Object.keys(tasksByCompany).length;
  const totalTasks = Object.values(tasksByCompany).reduce((s, t) => s + t.length, 0);
  info(`Companies with uninvoiced migrated tasks: ${companiesWithTasks}, total tasks: ${totalTasks}`);

  // ── Step 4: Group old invoices by user, then create new invoices ──
  section('Step 4: Creating invoices from worker_purchase_invoice');

  const defaultBankSnapshot = JSON.stringify({
    bankName: 'Historical Migration',
    accountTitle: 'N/A',
    accountNumber: 'N/A',
    note: 'Migrated from old Tasdeeq system',
  });

  // Map payment_status + status to new invoice status
  function mapStatus(paymentStatus, status) {
    if (paymentStatus === 'approved' && status === 'Paid') return 'APPROVED';
    if (paymentStatus === 'approved' && status === 'Verifications Given By Admin') return 'APPROVED';
    if (paymentStatus === 'rejected' && status === 'Paid') return 'APPROVED'; // paid but rejected = still paid
    if (paymentStatus === 'pending' && status === 'Paid') return 'APPROVED';
    if (paymentStatus === 'rejected' && status === 'Un-Paid') return 'CANCELLED';
    if (paymentStatus === 'pending' && status === 'Un-Paid') return 'PENDING_PAYMENT';
    return 'APPROVED'; // default safe
  }

  // Group old invoices by user_id
  const oldInvoicesByUser = {};
  for (const inv of oldInvoices) {
    const uid = Number(inv.user_id);
    if (!oldInvoicesByUser[uid]) oldInvoicesByUser[uid] = [];
    oldInvoicesByUser[uid].push(inv);
  }

  let invoicesCreated = 0;
  let itemsCreated = 0;
  let tasksLinked = 0;
  let skippedNoCompany = 0;
  let skippedNoTasks = 0;
  let usersProcessed = 0;

  const userIds = Object.keys(oldInvoicesByUser).map(Number);
  info(`Old users with invoices: ${userIds.length}`);

  for (const oldUserId of userIds) {
    const companyId = oldUserToCompany[oldUserId];
    if (!companyId) {
      skippedNoCompany++;
      continue;
    }

    const companyTasks = tasksByCompany[companyId];
    if (!companyTasks || companyTasks.length === 0) {
      skippedNoTasks++;
      continue;
    }

    const userInvoices = oldInvoicesByUser[oldUserId];
    let taskCursor = 0; // tracks which tasks have been assigned

    for (const oldInv of userInvoices) {
      const workerCount = Math.max(Number(oldInv.worker_count) || 0, 0);
      const totalAmount = Math.max(Number(oldInv.amount) || 0, 0);
      const unitPrice = workerCount > 0 ? Math.round(totalAmount / workerCount) : 0;
      const invoiceDate = oldInv.date ? new Date(oldInv.date) : new Date();
      const status = mapStatus(oldInv.payment_status, oldInv.status);

      // Take the next `workerCount` tasks for this invoice
      const assignedTasks = companyTasks.slice(taskCursor, taskCursor + workerCount);
      taskCursor += workerCount;

      if (assignedTasks.length === 0 && workerCount === 0) continue;

      const invoiceId = generateCuid();
      const invoiceNumber = `MIG-${oldInv.id}-${oldInv.invoice_number || oldUserId}`;

      // Create invoice
      await newDb.query(`
        INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
          "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'PREPAID', $6, $7, $8, $9, $8, $8)
      `, [
        invoiceId, invoiceNumber, companyId, SYSTEM_USER_ID,
        status, totalAmount, defaultBankSnapshot,
        invoiceDate, SYSTEM_USER_ID,
      ]);
      invoicesCreated++;

      // Create invoice items and link tasks
      if (assignedTasks.length > 0) {
        for (let i = 0; i < assignedTasks.length; i += BATCH) {
          const batch = assignedTasks.slice(i, i + BATCH);

          const itemValues = [];
          const itemParams = [];
          let paramIdx = 1;

          for (const task of batch) {
            const itemId = generateCuid();
            itemValues.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
            itemParams.push(itemId, invoiceId, task.taskId, unitPrice, invoiceDate);
          }

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
    }

    usersProcessed++;
    if (usersProcessed % 500 === 0) {
      info(`  Progress: ${usersProcessed}/${userIds.length} users, ${invoicesCreated} invoices, ${itemsCreated} items`);
    }
  }

  flushErrors();
  success(`Done!
  Users processed: ${usersProcessed}
  Skipped (no company mapping): ${skippedNoCompany}
  Skipped (no tasks): ${skippedNoTasks}
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
