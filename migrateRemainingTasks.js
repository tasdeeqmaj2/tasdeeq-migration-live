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
  section('Loading verification_ledger for pricing hints (bulk)');

  const userPriceCache = new Map(); // oldUserId → Map(oldEmpId → unitPrice)
  const oldUserIds = [...new Set(companyIds.map(c => reverseCompanyMap[c]).filter(Boolean))];
  info(`Old user IDs to look up: ${oldUserIds.length}`);

  // Bulk load ALL ledger entries and employments in large chunks (2 queries per chunk, not per user)
  const LEDGER_CHUNK = 5000;
  for (let i = 0; i < oldUserIds.length; i += LEDGER_CHUNK) {
    const chunk = oldUserIds.slice(i, i + LEDGER_CHUNK);
    try {
      // Single bulk query for ledger
      const { rows: ledgerRows } = await oldDb.query(`
        SELECT user_id, quantity, amount, date
        FROM public.verification_ledger
        WHERE user_id = ANY($1::bigint[]) AND transaction_type_id IN (3, 4, 5)
        ORDER BY user_id, date ASC, id ASC
      `, [chunk]);

      // Single bulk query for employments
      const { rows: empRows } = await oldDb.query(`
        SELECT user_id, id, registration_timestamp
        FROM public.user_worker_employment
        WHERE user_id = ANY($1::bigint[])
        ORDER BY user_id, registration_timestamp ASC, id ASC
      `, [chunk]);

      // Group by user
      const ledgerByUser = {};
      for (const r of ledgerRows) {
        const uid = Number(r.user_id);
        if (!ledgerByUser[uid]) ledgerByUser[uid] = [];
        ledgerByUser[uid].push(r);
      }

      const empsByUser = {};
      for (const r of empRows) {
        const uid = Number(r.user_id);
        if (!empsByUser[uid]) empsByUser[uid] = [];
        empsByUser[uid].push(r);
      }

      // Zip per user
      for (const [uid, rows] of Object.entries(ledgerByUser)) {
        const emps = empsByUser[uid] || [];
        const consumptions = [];
        for (const r of rows) {
          const qty = Math.abs(Number(r.quantity) || 1);
          const amt = Math.abs(Number(r.amount) || 0);
          const unitPrice = qty > 0 ? Math.round(amt / qty) : 0;
          for (let j = 0; j < qty; j++) {
            consumptions.push(unitPrice);
          }
        }
        const priceMap = new Map();
        for (let j = 0; j < emps.length && j < consumptions.length; j++) {
          priceMap.set(Number(emps[j].id), consumptions[j]);
        }
        userPriceCache.set(Number(uid), priceMap);
      }

      if ((i + LEDGER_CHUNK) % 20000 === 0 || i + LEDGER_CHUNK >= oldUserIds.length) {
        info(`  Ledger progress: ${Math.min(i + LEDGER_CHUNK, oldUserIds.length)}/${oldUserIds.length}`);
      }
    } catch (err) {
      warn(`Ledger lookup chunk error at ${i}: ${err.message}`);
    }
  }

  info(`Users with ledger pricing: ${userPriceCache.size}`);

  // ── Rollback any MIG-*-free invoices from a previous partial run ──
  section('Rolling back previous MIG-free invoices');
  const { rows: [{ cnt: freeCount }] } = await newDb.query(`
    SELECT COUNT(*)::int AS cnt FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%-free%'
  `);
  if (freeCount > 0) {
    await newDb.query(`UPDATE verification_tasks SET "invoiceId" = NULL WHERE "invoiceId" IN (SELECT id FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%-free%')`);
    await newDb.query(`DELETE FROM invoice_items WHERE "invoiceId" IN (SELECT id FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%-free%')`);
    const { rowCount } = await newDb.query(`DELETE FROM invoices WHERE "invoiceNumber" LIKE 'MIG-%-free%'`);
    info(`Rolled back ${rowCount} MIG-free invoices`);
  }

  // ── Also load verification_ledger entries grouped as "invoices" ──
  // Each ledger entry with quantity > 0 becomes a separate invoice
  section('Loading ledger entries as invoices for splitting');

  // Build per-user ledger invoices: group consecutive same-date entries
  const userLedgerInvoices = new Map(); // oldUserId → [{date, entries: [{quantity, amount, unitPrice}]}]

  for (let i = 0; i < oldUserIds.length; i += LEDGER_CHUNK) {
    const chunk = oldUserIds.slice(i, i + LEDGER_CHUNK);
    try {
      const { rows: ledgerRows } = await oldDb.query(`
        SELECT user_id, quantity, amount, date, transaction_type_id
        FROM public.verification_ledger
        WHERE user_id = ANY($1::bigint[]) AND transaction_type_id IN (3, 4, 5)
        ORDER BY user_id, date ASC, id ASC
      `, [chunk]);

      for (const r of ledgerRows) {
        const uid = Number(r.user_id);
        if (!userLedgerInvoices.has(uid)) userLedgerInvoices.set(uid, []);
        const qty = Math.abs(Number(r.quantity) || 1);
        const amt = Math.abs(Number(r.amount) || 0);
        const unitPrice = qty > 0 ? Math.round(amt / qty) : 0;
        userLedgerInvoices.get(uid).push({
          date: new Date(r.date),
          workerCount: qty,
          totalAmount: amt,
          unitPrice,
          type: Number(r.transaction_type_id),
        });
      }
    } catch (err) {
      warn(`Ledger invoice load error at ${i}: ${err.message}`);
    }
  }
  info(`Users with ledger invoice entries: ${userLedgerInvoices.size}`);

  // Create invoices — one per ledger entry, tasks assigned chronologically
  section('Creating invoices for remaining tasks');

  const defaultBankSnapshot = JSON.stringify({
    bankName: 'Historical Migration',
    accountTitle: 'N/A',
    accountNumber: 'N/A',
    note: 'Migrated from old Tasdeeq system',
  });

  let invoicesCreated = 0;
  let itemsCreated = 0;
  let tasksLinked = 0;
  let companiesProcessed = 0;

  for (const companyId of companyIds) {
    const tasks = tasksByCompany[companyId];
    if (!tasks || tasks.length === 0) continue;

    const oldUserId = reverseCompanyMap[companyId];
    const ledgerInvoices = oldUserId ? userLedgerInvoices.get(oldUserId) : null;

    let taskCursor = 0;

    if (ledgerInvoices && ledgerInvoices.length > 0) {
      // Create one invoice per ledger entry
      for (const entry of ledgerInvoices) {
        const assignedTasks = tasks.slice(taskCursor, taskCursor + entry.workerCount);
        taskCursor += entry.workerCount;
        if (assignedTasks.length === 0) continue;

        let totalAmount = Math.min(entry.unitPrice * assignedTasks.length, 99999999);
        const invoiceId = generateCuid();
        const label = entry.type === 4 ? 'paid' : entry.type === 3 ? 'admin' : 'bonus';
        const invoiceNumber = `MIG-${oldUserId}-free-${invoicesCreated}`;

        try {
          await newDb.query(`
            INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
              "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, 'APPROVED', 'PREPAID', $5, $6, $7, $8, $7, $7)
          `, [invoiceId, invoiceNumber, companyId, SYSTEM_USER_ID,
              totalAmount, defaultBankSnapshot, entry.date, SYSTEM_USER_ID]);
          invoicesCreated++;

          // Link tasks
          const itemValues = [];
          const itemParams = [];
          let paramIdx = 1;
          for (const task of assignedTasks) {
            const itemId = generateCuid();
            itemValues.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
            itemParams.push(itemId, invoiceId, task.taskId, entry.unitPrice, entry.date);
          }
          await newDb.query(`
            INSERT INTO invoice_items (id, "invoiceId", "taskId", "unitPrice", "createdAt")
            VALUES ${itemValues.join(', ')}
            ON CONFLICT ("taskId") DO NOTHING
          `, itemParams);
          const taskIds = assignedTasks.map(t => t.taskId);
          await newDb.query(`UPDATE verification_tasks SET "invoiceId" = $1 WHERE id = ANY($2::text[]) AND "invoiceId" IS NULL`, [invoiceId, taskIds]);
          itemsCreated += assignedTasks.length;
          tasksLinked += assignedTasks.length;
        } catch (err) {
          warn(`Error for company ${companyId} ledger entry: ${err.message}`);
        }
      }
    }

    // Any remaining tasks → group by exact date (day), use per-task pricing from ledger
    const remainingTasks = tasks.slice(taskCursor);
    if (remainingTasks.length > 0) {
      const empPriceMap = oldUserId ? userPriceCache.get(oldUserId) : null;

      // Group by exact date YYYY-MM-DD
      const byDate = {};
      for (const task of remainingTasks) {
        const d = new Date(task.createdAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!byDate[key]) byDate[key] = [];
        byDate[key].push(task);
      }

      const sortedDates = Object.keys(byDate).sort();
      for (const dateKey of sortedDates) {
        const dateTasks = byDate[dateKey];
        const invoiceId = generateCuid();
        const invoiceNumber = `MIG-${oldUserId || companyId.slice(0, 10)}-free-${dateKey}`;
        const invoiceDate = new Date(dateTasks[0].createdAt);

        // Calculate per-task prices from ledger
        let totalAmount = 0;
        const taskPrices = [];
        for (const task of dateTasks) {
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

        try {
          await newDb.query(`
            INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
              "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, 'APPROVED', 'PREPAID', $5, $6, $7, $8, $7, $7)
          `, [invoiceId, invoiceNumber, companyId, SYSTEM_USER_ID,
              totalAmount, defaultBankSnapshot, invoiceDate, SYSTEM_USER_ID]);
          invoicesCreated++;

          for (let i = 0; i < taskPrices.length; i += BATCH) {
            const batch = taskPrices.slice(i, i + BATCH);
            const itemValues = [];
            const itemParams = [];
            let paramIdx = 1;
            for (const tp of batch) {
              const itemId = generateCuid();
              itemValues.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
              itemParams.push(itemId, invoiceId, tp.taskId, tp.unitPrice, invoiceDate);
            }
            await newDb.query(`
              INSERT INTO invoice_items (id, "invoiceId", "taskId", "unitPrice", "createdAt")
              VALUES ${itemValues.join(', ')}
              ON CONFLICT ("taskId") DO NOTHING
            `, itemParams);
            const taskIds = batch.map(tp => tp.taskId);
            await newDb.query(`UPDATE verification_tasks SET "invoiceId" = $1 WHERE id = ANY($2::text[]) AND "invoiceId" IS NULL`, [invoiceId, taskIds]);
            itemsCreated += batch.length;
            tasksLinked += batch.length;
          }
        } catch (err) {
          warn(`Error for company ${companyId} date ${dateKey}: ${err.message}`);
        }
      }
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
