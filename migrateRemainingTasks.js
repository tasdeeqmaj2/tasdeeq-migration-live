/**
 * Create MIG- invoices for migrated tasks that were NOT covered by
 * worker_purchase_invoice (free / admin-given verifications).
 *
 * Groups remaining unlinked migrated tasks by company, creates one
 * MIG-FREE-{companyId} invoice per company with amount = 0.
 * Also tries verification_ledger (public schema) for unit pricing.
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
  section('Migrate remaining tasks (not covered by worker_purchase_invoice)');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap(USER_MAP_NAME);
  const taskMap = loadMap(TASK_MAP_NAME);

  // Build reverse maps
  const reverseCompanyMap = {};
  for (const [oldUserId, newCompanyId] of Object.entries(companyMap)) {
    const parsed = parseOldUserId(oldUserId);
    if (parsed !== null) {
      reverseCompanyMap[newCompanyId] = parsed;
    }
  }

  const reverseTaskMap = {};
  for (const [oldId, newId] of Object.entries(taskMap)) {
    reverseTaskMap[newId] = Number(oldId);
  }

  // Load migrated tasks that still have no invoice
  section('Loading unlinked migrated tasks');
  const migratedTaskIds = Object.values(taskMap);
  info(`Total migrated task IDs: ${migratedTaskIds.length}`);

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

  const companyIds = Object.keys(tasksByCompany);
  const totalTasks = Object.values(tasksByCompany).reduce((s, t) => s + t.length, 0);
  info(`Companies with unlinked migrated tasks: ${companyIds.length}, total tasks: ${totalTasks}`);

  if (totalTasks === 0) {
    success('No remaining tasks to process.');
    return;
  }

  // Try to get unit prices from verification_ledger (public schema)
  // type 3 = free given by admin, type 5 = bonus/promo
  section('Loading verification_ledger for pricing hints');

  // Build a cache of old user → per-employment price from ledger
  // We'll use types 3, 4, 5 from public.verification_ledger
  const userPriceCache = new Map(); // oldUserId → Map(oldEmpId → unitPrice)

  const oldUserIds = [...new Set(companyIds.map(c => reverseCompanyMap[c]).filter(Boolean))];
  info(`Old user IDs to look up in ledger: ${oldUserIds.length}`);

  // Process in chunks
  for (let i = 0; i < oldUserIds.length; i += 200) {
    const chunk = oldUserIds.slice(i, i + 200);
    try {
      const { rows: ledgerRows } = await oldDb.query(`
        SELECT user_id, quantity, amount, date
        FROM public.verification_ledger
        WHERE user_id = ANY($1::bigint[]) AND transaction_type_id IN (3, 4, 5)
        ORDER BY user_id, date ASC, id ASC
      `, [chunk]);

      // Group by user
      const byUser = {};
      for (const r of ledgerRows) {
        const uid = Number(r.user_id);
        if (!byUser[uid]) byUser[uid] = [];
        byUser[uid].push(r);
      }

      for (const [uid, rows] of Object.entries(byUser)) {
        // Get this user's employments sorted by date
        const { rows: emps } = await oldDb.query(`
          SELECT id, registration_timestamp
          FROM public.user_worker_employment
          WHERE user_id = $1
          ORDER BY registration_timestamp ASC, id ASC
        `, [Number(uid)]);

        // Build consumption timeline
        const consumptions = [];
        for (const r of rows) {
          const qty = Math.abs(Number(r.quantity) || 1);
          const amt = Math.abs(Number(r.amount) || 0);
          const unitPrice = qty > 0 ? Math.round(amt / qty) : 0;
          for (let j = 0; j < qty; j++) {
            consumptions.push(unitPrice);
          }
        }

        // Zip employments with prices
        const priceMap = new Map();
        for (let j = 0; j < emps.length && j < consumptions.length; j++) {
          priceMap.set(Number(emps[j].id), consumptions[j]);
        }
        userPriceCache.set(Number(uid), priceMap);
      }
    } catch (err) {
      warn(`Ledger lookup chunk error: ${err.message}`);
    }
  }

  info(`Users with ledger pricing: ${userPriceCache.size}`);

  // Create invoices
  section('Creating invoices for remaining tasks');

  const defaultBankSnapshot = JSON.stringify({
    bankName: 'Historical Migration',
    accountTitle: 'N/A',
    accountNumber: 'N/A',
    note: 'Migrated from old Tasdeeq system (free/admin-given verifications)',
  });

  let invoicesCreated = 0;
  let itemsCreated = 0;
  let tasksLinked = 0;
  let companiesProcessed = 0;

  for (const companyId of companyIds) {
    const tasks = tasksByCompany[companyId];
    if (!tasks || tasks.length === 0) continue;

    const oldUserId = reverseCompanyMap[companyId];
    const empPriceMap = oldUserId ? userPriceCache.get(oldUserId) : null;

    // Calculate per-task prices
    let totalAmount = 0;
    const taskPrices = [];
    for (const task of tasks) {
      let unitPrice = 0;
      if (empPriceMap) {
        const oldEmpId = reverseTaskMap[task.taskId];
        if (oldEmpId) {
          unitPrice = empPriceMap.get(oldEmpId) ?? 0;
        }
      }
      unitPrice = Math.min(unitPrice, 99999999);
      taskPrices.push({ taskId: task.taskId, unitPrice });
      totalAmount += unitPrice;
    }

    totalAmount = Math.min(totalAmount, 99999999);

    const earliestDate = tasks.reduce((min, t) => {
      const d = new Date(t.createdAt);
      return d < min ? d : min;
    }, new Date(tasks[0].createdAt));

    const invoiceId = generateCuid();
    const invoiceNumber = `MIG-${oldUserId || companyId.slice(0, 10)}-free`;

    try {
      await newDb.query(`
        INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
          "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, 'APPROVED', 'PREPAID', $5, $6, $7, $8, $7, $7)
      `, [
        invoiceId, invoiceNumber, companyId, SYSTEM_USER_ID,
        totalAmount, defaultBankSnapshot,
        earliestDate, SYSTEM_USER_ID,
      ]);
      invoicesCreated++;

      // Create items and link tasks in batches
      for (let i = 0; i < taskPrices.length; i += BATCH) {
        const batch = taskPrices.slice(i, i + BATCH);
        const itemValues = [];
        const itemParams = [];
        let paramIdx = 1;

        for (const tp of batch) {
          const itemId = generateCuid();
          itemValues.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
          itemParams.push(itemId, invoiceId, tp.taskId, tp.unitPrice, earliestDate);
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
    } catch (err) {
      warn(`Error for company ${companyId}: ${err.message}`);
    }

    companiesProcessed++;
    if (companiesProcessed % 1000 === 0) {
      info(`  Progress: ${companiesProcessed}/${companyIds.length} companies, ${invoicesCreated} invoices, ${itemsCreated} items`);
    }
  }

  flushErrors();
  success(`Done!
  Companies processed: ${companiesProcessed}
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
