/**
 * Migrate ALL unmapped old users (~6,258) who are NOT in companyMap.json.
 * Creates: Company (isConsumer=true) → User → CorporateUser → Workers → VerificationTasks → Invoices → InvoiceItems
 * Links receipts from receiptMap.json where available.
 *
 * Usage:  node migrateUnmappedUsers.js
 * Resume: re-run — skips users already in unmappedUserMap.json
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap, saveMap } = require('./utils/maps');
const { createId } = require('./utils/batch');
const { resolveEmail, resolvePhone } = require('./utils/contactFields');
const { section, info, success, warn, flushErrors } = require('./utils/logger');

const SYSTEM_USER_ID = 'cmwnhyial8dec1ccd12b0c75a';
const MIGRATION = 'unmapped_users';

const BANK_SNAPSHOT = JSON.stringify({
  bankName: 'Historical Migration',
  accountTitle: 'N/A',
  accountNumber: 'N/A',
  note: 'Auto-created during unmapped-user migration',
});

function generateCuid() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 12);
  return `c${ts}${rand}`.slice(0, 25);
}

async function main() {
  section('Migrate unmapped old users');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap('companyMap.json');

  // Build set of already-mapped old user IDs
  const mappedOldUserIds = new Set();
  for (const key of Object.keys(companyMap)) {
    const stripped = String(key).replace(/^hh-/, '');
    const num = Number(stripped);
    if (!isNaN(num)) mappedOldUserIds.add(num);
  }
  info(`Already mapped old user IDs: ${mappedOldUserIds.size}`);

  // Load or create unmapped user map (for resume)
  const mapPath = path.join(__dirname, 'mappings', 'unmappedUserMap.json');
  let unmappedMap = {};
  if (fs.existsSync(mapPath)) {
    unmappedMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    info(`Resuming: ${Object.keys(unmappedMap).length} users already migrated`);
  }

  // Load receipt map if available
  const receiptMapPath = path.join(__dirname, 'mappings', 'receiptMap.json');
  let receiptMap = {};
  if (fs.existsSync(receiptMapPath)) {
    receiptMap = JSON.parse(fs.readFileSync(receiptMapPath, 'utf8'));
    info(`Receipt map loaded: ${Object.keys(receiptMap).length} entries`);
  }

  // Load ALL old users
  section('Loading old users');
  const { rows: allOldUsers } = await oldDb.query(`
    SELECT id, name, email, phone_number, cnic, is_active, created_at
    FROM "user"
    ORDER BY id ASC
  `);
  info(`Total old users: ${allOldUsers.length}`);

  // Filter to unmapped only
  const unmappedUsers = allOldUsers.filter(u => !mappedOldUserIds.has(Number(u.id)));
  info(`Unmapped users to migrate: ${unmappedUsers.length}`);

  // Pre-load old workers for all unmapped users
  section('Loading old worker data');
  const unmappedIds = unmappedUsers.map(u => Number(u.id));

  // Load user_worker_employment in chunks
  const empByUser = {};
  for (let i = 0; i < unmappedIds.length; i += 5000) {
    const chunk = unmappedIds.slice(i, i + 5000);
    const { rows } = await oldDb.query(`
      SELECT uwe.id AS emp_id, uwe.user_id, uwe.worker_id, uwe.full_name,
             uwe.is_active, uwe.registration_timestamp,
             uwe.cplc_verification_status, uwe.sindh_police_verification_status,
             uwe.islamabad_police_verification_status, uwe.verification_timestamp,
             w.cnic AS worker_cnic, w.phone_number AS worker_phone
      FROM user_worker_employment uwe
      LEFT JOIN worker w ON w.id = uwe.worker_id
      WHERE uwe.user_id = ANY($1::bigint[])
      ORDER BY uwe.user_id, uwe.id
    `, [chunk]);
    for (const r of rows) {
      const uid = Number(r.user_id);
      if (!empByUser[uid]) empByUser[uid] = [];
      empByUser[uid].push(r);
    }
  }
  info(`Users with workers: ${Object.keys(empByUser).length}`);

  // Load old invoices for unmapped users
  const invoicesByUser = {};
  for (let i = 0; i < unmappedIds.length; i += 5000) {
    const chunk = unmappedIds.slice(i, i + 5000);
    const { rows } = await oldDb.query(`
      SELECT id, user_id, invoice_number, amount, date, payment_status, status, invoice_document
      FROM worker_purchase_invoice
      WHERE user_id = ANY($1::bigint[])
      ORDER BY user_id, date ASC
    `, [chunk]);
    for (const r of rows) {
      const uid = Number(r.user_id);
      if (!invoicesByUser[uid]) invoicesByUser[uid] = [];
      invoicesByUser[uid].push(r);
    }
  }
  info(`Users with invoices: ${Object.keys(invoicesByUser).length}`);

  // Load verification_ledger consumption entries (types 3,4,5,6 = per-verification charges)
  // sorted by date so we can pair them 1:1 with workers sorted by registration date
  const consumptionByUser = {};
  for (let i = 0; i < unmappedIds.length; i += 5000) {
    const chunk = unmappedIds.slice(i, i + 5000);
    const { rows } = await oldDb.query(`
      SELECT user_id, amount, quantity, date
      FROM verification_ledger
      WHERE user_id = ANY($1::bigint[]) AND transaction_type_id IN (3, 4, 5, 6)
      ORDER BY user_id, date ASC
    `, [chunk]);
    for (const r of rows) {
      const uid = Number(r.user_id);
      if (!consumptionByUser[uid]) consumptionByUser[uid] = [];
      // Expand bulk entries (qty > 1) into individual entries
      const qty = Number(r.quantity) || 1;
      const perUnit = qty > 0 ? Math.round((Number(r.amount) / qty) * 100) / 100 : 0;
      for (let q = 0; q < qty; q++) {
        consumptionByUser[uid].push({ price: perUnit, date: r.date });
      }
    }
  }
  info(`Users with consumption ledger entries: ${Object.keys(consumptionByUser).length}`);

  // Check existing emails in new DB to avoid conflicts
  section('Loading existing emails from new DB');
  const { rows: existingEmails } = await newDb.query(`SELECT email FROM users WHERE email IS NOT NULL`);
  const usedEmails = new Set(existingEmails.map(r => r.email.toLowerCase()));
  info(`Existing emails in new DB: ${usedEmails.size}`);

  const { rows: existingPhones } = await newDb.query(`SELECT phone FROM users WHERE phone IS NOT NULL`);
  const usedPhones = new Set(existingPhones.map(r => r.phone));
  info(`Existing phones in new DB: ${usedPhones.size}`);

  // Migrate each unmapped user
  section('Migrating unmapped users');
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let totalWorkers = 0;
  let totalTasks = 0;
  let totalInvoices = 0;

  for (let idx = 0; idx < unmappedUsers.length; idx++) {
    const oldUser = unmappedUsers[idx];
    const oldUserId = Number(oldUser.id);

    // Skip if already done (resume)
    if (unmappedMap[oldUserId]) {
      skipped++;
      continue;
    }

    const client = await newDb.connect();
    try {
      await client.query('BEGIN');

      // Resolve contact fields
      const email = resolveEmail(oldUser.email, { migration: MIGRATION, oldId: oldUserId });
      const phone = resolvePhone(oldUser.phone_number, { migration: MIGRATION, oldId: oldUserId });
      const name = oldUser.name || `User ${oldUserId}`;

      // Generate unique email if conflict or missing
      let finalEmail = email;
      if (!finalEmail || usedEmails.has(finalEmail.toLowerCase())) {
        finalEmail = `migrated-${oldUserId}@consumer.tasdeeq.app`;
      }
      usedEmails.add(finalEmail.toLowerCase());

      // Phone: skip if conflict
      let finalPhone = phone;
      if (finalPhone && usedPhones.has(finalPhone)) {
        finalPhone = null; // can't set, already taken
      }
      if (finalPhone) usedPhones.add(finalPhone);

      // 1. Create Company (isConsumer = true)
      const companyId = createId();
      await client.query(`
        INSERT INTO companies (id, name, email, phone, "isConsumer", "isActive", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, true, $5, $6, $6)
      `, [companyId, name, finalEmail, finalPhone, oldUser.is_active !== false, oldUser.created_at || new Date()]);

      // 2. Create User
      const userId = createId();
      await client.query(`
        INSERT INTO users (id, name, email, "emailVerified", phone, "phoneVerified", role, banned, "isSuperAdmin", "isActive", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, true, $4, $5, 'CONSUMER', false, false, $6, $7, $7)
        ON CONFLICT (email) DO NOTHING
      `, [userId, name, finalEmail, finalPhone, !!finalPhone, oldUser.is_active !== false, oldUser.created_at || new Date()]);

      // Check if the user was actually inserted (email conflict might cause skip)
      const { rows: checkUser } = await client.query(`SELECT id FROM users WHERE email = $1`, [finalEmail]);
      const actualUserId = checkUser.length > 0 ? checkUser[0].id : userId;

      // 3. Create CorporateUser link
      const corpUserId = createId();
      await client.query(`
        INSERT INTO corporate_users (id, "userId", "companyId", "isAdmin", role)
        VALUES ($1, $2, $3, true, 'OWNER')
        ON CONFLICT ("userId") DO NOTHING
      `, [corpUserId, actualUserId, companyId]);

      // 4. Migrate workers
      const employments = empByUser[oldUserId] || [];
      const workerIdMap = {}; // empId → newWorkerId

      for (const emp of employments) {
        const workerId = createId();
        const workerCnic = emp.worker_cnic ? String(emp.worker_cnic).replace(/\D/g, '') : null;
        if (!workerCnic || workerCnic.length < 13) continue; // skip workers without valid CNIC

        const workerPhone = resolvePhone(emp.worker_phone, { migration: MIGRATION, oldId: emp.emp_id, required: true });
        const workerName = emp.full_name || `Worker ${emp.worker_id}`;

        await client.query(`
          INSERT INTO workers (id, "companyId", "createdById", name, email, mobile, cnic, "hiringArea", "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, '', $5, $6, 'HOUSEHOLD', $7, $7)
        `, [workerId, companyId, SYSTEM_USER_ID, workerName, workerPhone, workerCnic, emp.registration_timestamp || oldUser.created_at || new Date()]);

        workerIdMap[Number(emp.emp_id)] = workerId;
        totalWorkers++;
      }

      // 5. Create verification tasks
      const tasksByEmp = {}; // empId → newTaskId
      for (const emp of employments) {
        const newWorkerId = workerIdMap[Number(emp.emp_id)];
        if (!newWorkerId) continue;

        // Map old status
        let status = 'DRAFT';
        const cplc = String(emp.cplc_verification_status || '').toUpperCase();
        const sindh = String(emp.sindh_police_verification_status || '').toUpperCase();
        const isb = String(emp.islamabad_police_verification_status || '').toUpperCase();
        if ([cplc, sindh, isb].some(s => ['CLEARED', 'CRIMINAL_RECORD', 'NOT_CHECKED'].includes(s))) {
          status = 'COMPLETED';
        } else if ([cplc, sindh, isb].some(s => s === 'PENDING' || s === 'ASSIGNED')) {
          status = 'PENDING';
        } else if ([cplc, sindh, isb].some(s => s === 'CANCELLED')) {
          status = 'CANCELLED';
        }

        const taskId = createId();
        await client.query(`
          INSERT INTO verification_tasks (id, "workerId", "companyId", "createdById", type, status, "filledBy", "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, 'CRIMINAL', $5, 'CORPORATE', $6, $6)
        `, [taskId, newWorkerId, companyId, SYSTEM_USER_ID, status, emp.registration_timestamp || oldUser.created_at || new Date()]);

        tasksByEmp[Number(emp.emp_id)] = taskId;
        totalTasks++;
      }

      // 6. Create invoices grouped by date with per-task pricing
      const taskIds = Object.values(tasksByEmp);
      if (taskIds.length > 0) {
        // Match each task to its consumption entry by date order
        // Sort employments by registration date, consumption entries are already sorted by date
        const sortedEmps = employments
          .filter(e => tasksByEmp[Number(e.emp_id)])
          .sort((a, b) => new Date(a.registration_timestamp || 0) - new Date(b.registration_timestamp || 0));
        const consumptions = consumptionByUser[oldUserId] || [];

        // Pair tasks with consumption entries 1:1 by chronological order
        const taskPriceMap = {}; // taskId → unitPrice
        for (let ti = 0; ti < sortedEmps.length; ti++) {
          const emp = sortedEmps[ti];
          const tid = tasksByEmp[Number(emp.emp_id)];
          if (ti < consumptions.length) {
            taskPriceMap[tid] = consumptions[ti].price;
          } else {
            // More tasks than consumption entries — use last known price or 0
            taskPriceMap[tid] = consumptions.length > 0 ? consumptions[consumptions.length - 1].price : 0;
          }
        }

        // Group tasks by date (from their employment registration_timestamp)
        const tasksByDate = {};
        for (const emp of employments) {
          const tid = tasksByEmp[Number(emp.emp_id)];
          if (!tid) continue;
          const d = emp.registration_timestamp || oldUser.created_at || new Date();
          const dateKey = new Date(d).toISOString().slice(0, 10);
          if (!tasksByDate[dateKey]) tasksByDate[dateKey] = [];
          tasksByDate[dateKey].push({ taskId: tid, date: d, unitPrice: taskPriceMap[tid] || 0 });
        }

        for (const [dateKey, tasks] of Object.entries(tasksByDate)) {
          const invoiceId = createId();
          const totalAmount = Math.min(tasks.reduce((s, t) => s + t.unitPrice, 0), 99999999);
          const invoiceDate = tasks[0].date;

          await client.query(`
            INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode", "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, 'APPROVED', 'PREPAID', $5, $6, $7, $4, $7, $7)
          `, [invoiceId, `MIG-U-${oldUserId}-${dateKey}`, companyId, SYSTEM_USER_ID, totalAmount, BANK_SNAPSHOT, invoiceDate]);

          // Link tasks to invoice + create items
          for (const t of tasks) {
            await client.query(`
              UPDATE verification_tasks SET "invoiceId" = $1 WHERE id = $2
            `, [invoiceId, t.taskId]);

            await client.query(`
              INSERT INTO invoice_items (id, "invoiceId", "taskId", "unitPrice", "createdAt")
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT ("taskId") DO NOTHING
            `, [createId(), invoiceId, t.taskId, t.unitPrice, invoiceDate]);
          }

          // Link receipt from receiptMap if available
          const oldInvoices = invoicesByUser[oldUserId] || [];
          for (const oi of oldInvoices) {
            const rm = receiptMap[String(oi.id)];
            if (rm && rm.s3Key) {
              const oiDate = new Date(oi.date);
              const invDate = new Date(invoiceDate);
              const diff = Math.abs(oiDate.getTime() - invDate.getTime());
              if (diff < 30 * 24 * 60 * 60 * 1000) { // within 30 days
                await client.query(`
                  UPDATE invoices SET "receiptKey" = $1, "receiptUploadedAt" = $2 WHERE id = $3 AND "receiptKey" IS NULL
                `, [rm.s3Key, oiDate, invoiceId]);
                break;
              }
            }
          }

          totalInvoices++;
        }
      }

      await client.query('COMMIT');

      unmappedMap[oldUserId] = {
        companyId,
        userId: actualUserId,
        workers: Object.keys(workerIdMap).length,
        tasks: taskIds.length,
      };
      migrated++;

      if ((migrated + skipped) % 500 === 0) {
        info(`  Progress: ${migrated + skipped}/${unmappedUsers.length} — migrated: ${migrated}, skipped (resume): ${skipped}, failed: ${failed}`);
        fs.writeFileSync(mapPath, JSON.stringify(unmappedMap, null, 2));
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      warn(`Failed user ${oldUserId}: ${err.message}`);
      failed++;
    } finally {
      client.release();
    }
  }

  // Final save
  fs.writeFileSync(mapPath, JSON.stringify(unmappedMap, null, 2));

  flushErrors();
  success(`Done!
  Total unmapped users: ${unmappedUsers.length}
  Migrated: ${migrated}
  Skipped (already done): ${skipped}
  Failed: ${failed}
  Workers created: ${totalWorkers}
  Tasks created: ${totalTasks}
  Invoices created: ${totalInvoices}
  Map saved: ${mapPath}`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
