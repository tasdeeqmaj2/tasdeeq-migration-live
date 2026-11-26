/**
 * Fix invoice history migration.
 *
 * Approach: start from NEW companies that have completed tasks,
 * find their old user via existing MIG-BAL invoices (which store oldUserId),
 * then recreate invoices from old worker_purchase_invoice history.
 *
 * This script:
 * 1. Removes all incorrectly grouped MIG- invoices (keeps MIG-BAL-*, INV-*, non-MIG)
 * 2. For each company, finds old user via MIG-BAL bankDetailsSnapshot
 * 3. Recreates invoices from old worker_purchase_invoice (approved only)
 * 4. Links verification tasks to invoices chronologically
 * 5. Remaining tasks get monthly settlement invoices
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');
const { decryptIfEncrypted } = require('./utils/decrypt');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;

const OLD_DB_URL = process.env.OLD_DATABASE_URL;
const NEW_DB_URL = process.env.NEW_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
if (!OLD_DB_URL) { console.error('Set OLD_DATABASE_URL in .env'); process.exit(1); }

const CURRENT_UNIT_PRICE = 500;
const BATCH_SIZE = 500;

function getUnitPrice(date) {
  const d = new Date(date);
  const ym = d.getFullYear() * 100 + (d.getMonth() + 1);
  if (ym >= 202607) return 500;
  if (ym >= 202601) return 400;
  if (ym >= 202502) return 300;
  if (ym >= 202408) return 250;
  if (ym >= 202311) return 100;
  return 50;
}

function cuid() {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}

async function run() {
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  await oldDb.connect();
  await newDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);

  // Find super_admin
  const { rows: [admin] } = await newDb.query(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
  if (!admin) { console.error('No super_admin found'); await cleanup(); return; }

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: Build companyId → oldUserId mapping from MIG-BAL invoices
  // ═══════════════════════════════════════════════════════════════
  console.log('=== Building company → old user mapping ===\n');

  const { rows: migBalInvoices } = await newDb.query(`
    SELECT "companyId", "bankDetailsSnapshot" FROM invoices
    WHERE "invoiceNumber" LIKE 'MIG-BAL-%'
  `);

  const companyToOldUser = {}; // newCompanyId → oldUserId
  for (const inv of migBalInvoices) {
    const snap = inv.bankDetailsSnapshot;
    if (snap && snap.oldUserId) {
      companyToOldUser[inv.companyId] = String(snap.oldUserId);
    }
  }
  console.log(`Companies with old user mapping (from MIG-BAL): ${Object.keys(companyToOldUser).length}`);

  // Also build from migrated email pattern
  const { rows: migratedUsers } = await newDb.query(`
    SELECT u.email, cu."companyId"
    FROM users u
    JOIN corporate_users cu ON cu."userId" = u.id
    WHERE u.email LIKE 'migrated-%@consumer.tasdeeq.app'
  `);
  let addedFromMigrated = 0;
  for (const r of migratedUsers) {
    const match = r.email.match(/^migrated-(\d+)@/);
    if (match && !companyToOldUser[r.companyId]) {
      companyToOldUser[r.companyId] = match[1];
      addedFromMigrated++;
    }
  }
  console.log(`Added from migrated emails: ${addedFromMigrated}`);

  // Also build from decrypted old user emails → new user emails
  const mappedOldUserIds = new Set(Object.values(companyToOldUser));
  const { rows: oldUsersForLookup } = await oldDb.query(`
    SELECT DISTINCT u.id, u.email, u.phone_number AS phone
    FROM "user" u
    JOIN worker_purchase_invoice wpi ON wpi.user_id = u.id
    WHERE wpi.payment_status = 'approved'
  `);

  // Build decrypted email → oldUserId for unmapped users
  const decEmailToOldId = {};
  for (const u of oldUsersForLookup) {
    if (mappedOldUserIds.has(String(u.id))) continue;
    const decEmail = decryptIfEncrypted(u.email);
    if (decEmail && decEmail.includes('@')) {
      decEmailToOldId[decEmail.toLowerCase()] = String(u.id);
    }
  }
  console.log(`Unmapped old users with decrypted emails: ${Object.keys(decEmailToOldId).length}`);

  // Bulk lookup new users by these emails → company
  const emailsToLookup = Object.keys(decEmailToOldId);
  let addedFromDecrypted = 0;
  for (let i = 0; i < emailsToLookup.length; i += 5000) {
    const chunk = emailsToLookup.slice(i, i + 5000);
    const { rows } = await newDb.query(`
      SELECT LOWER(u.email) AS email, cu."companyId"
      FROM users u
      JOIN corporate_users cu ON cu."userId" = u.id
      WHERE LOWER(u.email) = ANY($1::text[])
    `, [chunk]);
    for (const r of rows) {
      const oldId = decEmailToOldId[r.email];
      if (oldId && !companyToOldUser[r.companyId]) {
        companyToOldUser[r.companyId] = oldId;
        addedFromDecrypted++;
      }
    }
  }
  console.log(`Added from decrypted emails: ${addedFromDecrypted}`);

  // Also try decrypted phone numbers for remaining unmapped users
  const stillUnmapped = oldUsersForLookup.filter(u => !Object.values(companyToOldUser).includes(String(u.id)));
  const decPhoneToOldId = {};
  for (const u of stillUnmapped) {
    const decPhone = decryptIfEncrypted(u.phone);
    if (decPhone && /^\d/.test(decPhone)) {
      const p1 = decPhone;
      const p2 = decPhone.replace(/^0/, '+92');
      decPhoneToOldId[p1] = String(u.id);
      decPhoneToOldId[p2] = String(u.id);
    }
  }
  const phonesToLookup = Object.keys(decPhoneToOldId);
  let addedFromPhone = 0;
  for (let i = 0; i < phonesToLookup.length; i += 5000) {
    const chunk = phonesToLookup.slice(i, i + 5000);
    const { rows } = await newDb.query(`
      SELECT u.phone, cu."companyId"
      FROM users u
      JOIN corporate_users cu ON cu."userId" = u.id
      WHERE u.phone = ANY($1::text[])
    `, [chunk]);
    for (const r of rows) {
      const oldId = decPhoneToOldId[r.phone];
      if (oldId && !companyToOldUser[r.companyId]) {
        companyToOldUser[r.companyId] = oldId;
        addedFromPhone++;
      }
    }
  }
  console.log(`Added from decrypted phones: ${addedFromPhone}`);
  console.log(`Total company → old user mappings: ${Object.keys(companyToOldUser).length}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Load ALL old purchase invoices by user
  // ═══════════════════════════════════════════════════════════════
  console.log('=== Loading old purchase invoices ===\n');

  const { rows: oldInvoices } = await oldDb.query(`
    SELECT id AS old_id, user_id, invoice_number, amount, worker_count, date, status
    FROM worker_purchase_invoice
    WHERE payment_status = 'approved'
      AND worker_count > 0
      AND worker_count < 50000
    ORDER BY user_id, date ASC
  `);
  console.log(`Approved old invoices (sane): ${oldInvoices.length}`);

  const invoicesByOldUser = {}; // oldUserId → [invoices]
  for (const inv of oldInvoices) {
    const uid = String(inv.user_id);
    if (!invoicesByOldUser[uid]) invoicesByOldUser[uid] = [];
    invoicesByOldUser[uid].push(inv);
  }
  console.log(`Distinct old users with purchases: ${Object.keys(invoicesByOldUser).length}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: Find all companies with completed tasks
  // ═══════════════════════════════════════════════════════════════
  console.log('=== Loading companies with completed tasks ===\n');

  const { rows: companiesWithTasks } = await newDb.query(`
    SELECT "companyId", COUNT(*)::int AS task_count
    FROM verification_tasks
    WHERE status = 'COMPLETED'
    GROUP BY "companyId"
    ORDER BY task_count DESC
  `);
  console.log(`Companies with completed tasks: ${companiesWithTasks.length}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 4: Remove incorrect MIG- invoices
  // ═══════════════════════════════════════════════════════════════
  console.log('=== Removing incorrect MIG- invoices ===\n');

  // Find migrated invoices (MIG- prefix OR renamed INV- with migration bankDetailsSnapshot)
  const { rows: [{ cnt: migCount }] } = await newDb.query(`
    SELECT COUNT(*)::int AS cnt FROM invoices
    WHERE "invoiceNumber" NOT LIKE 'MIG-BAL-%'
      AND (
        "invoiceNumber" LIKE 'MIG-%'
        OR ("bankDetailsSnapshot"::text LIKE '%Migrated from old%'
            OR "bankDetailsSnapshot"::text LIKE '%Free/admin%'
            OR "bankDetailsSnapshot"::text LIKE '%settlement%')
      )
  `);
  console.log(`Migration invoices to remove: ${migCount}`);

  if (!DRY_RUN && migCount > 0) {
    const migFilter = `
      "invoiceNumber" NOT LIKE 'MIG-BAL-%'
      AND (
        "invoiceNumber" LIKE 'MIG-%'
        OR ("bankDetailsSnapshot"::text LIKE '%Migrated from old%'
            OR "bankDetailsSnapshot"::text LIKE '%Free/admin%'
            OR "bankDetailsSnapshot"::text LIKE '%settlement%')
      )
    `;

    const { rowCount: unlinked } = await newDb.query(`
      UPDATE verification_tasks SET "invoiceId" = NULL
      WHERE "invoiceId" IN (SELECT id FROM invoices WHERE ${migFilter})
    `);
    console.log(`Unlinked ${unlinked} tasks`);

    const { rowCount: itemsDeleted } = await newDb.query(`
      DELETE FROM invoice_items
      WHERE "invoiceId" IN (SELECT id FROM invoices WHERE ${migFilter})
    `);
    console.log(`Deleted ${itemsDeleted} invoice items`);

    const { rowCount: invoicesDeleted } = await newDb.query(`
      DELETE FROM invoices WHERE ${migFilter}
    `);
    console.log(`Deleted ${invoicesDeleted} invoices`);
  } else if (DRY_RUN) {
    console.log(`[DRY] Would remove ${migCount} invoices and their items/links`);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 5: Bulk-load ALL unlinked completed tasks
  // ═══════════════════════════════════════════════════════════════
  console.log('\n=== Bulk-loading all unlinked completed tasks ===\n');

  const tasksByCompany = new Map(); // companyId → [{id, createdAt}, ...] sorted by createdAt
  {
    const { rows: allTasks } = await newDb.query(`
      SELECT id, "companyId", "createdAt" FROM verification_tasks
      WHERE status = 'COMPLETED' AND "invoiceId" IS NULL
      ORDER BY "companyId", "createdAt" ASC
    `);
    for (const t of allTasks) {
      let arr = tasksByCompany.get(t.companyId);
      if (!arr) { arr = []; tasksByCompany.set(t.companyId, arr); }
      arr.push({ id: t.id, createdAt: t.createdAt });
    }
    console.log(`Loaded ${allTasks.length} unlinked tasks across ${tasksByCompany.size} companies\n`);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 6: Create invoices from purchase history
  // ═══════════════════════════════════════════════════════════════
  console.log('=== Creating invoices from purchase history ===\n');

  let totalPaidInvoices = 0;
  let totalFreeInvoices = 0;
  let totalSettleInvoices = 0;
  let totalItemsCreated = 0;
  let totalTasksLinked = 0;
  let companiesWithHistory = 0;
  let companiesWithoutHistory = 0;

  if (!DRY_RUN) await newDb.query('BEGIN');

  try {
    for (const comp of companiesWithTasks) {
      const companyId = comp.companyId;
      const oldUserId = companyToOldUser[companyId];
      const userPurchases = oldUserId ? invoicesByOldUser[oldUserId] : null;

      const tasks = tasksByCompany.get(companyId);
      if (!tasks || tasks.length === 0) continue;

      let taskCursor = 0;

      if (userPurchases && userPurchases.length > 0) {
        companiesWithHistory++;

        // Create one invoice per old purchase, link tasks chronologically
        for (const oldInv of userPurchases) {
          const workerCount = Number(oldInv.worker_count);
          const datePrice = getUnitPrice(oldInv.date);
          const amount = Number(oldInv.amount) || (workerCount * datePrice);
          const unitPrice = workerCount > 0 ? Math.round(amount / workerCount) : datePrice;
          const invoiceDate = oldInv.date;

          const assignedTasks = tasks.slice(taskCursor, taskCursor + workerCount);
          taskCursor += workerCount;
          if (assignedTasks.length === 0) continue;

          const invoiceId = cuid();
          const invoiceNumber = `MIG-WPI-${oldInv.old_id}-${companyId}`;
          const invoiceAmount = unitPrice * assignedTasks.length;

          if (!DRY_RUN) {
            await newDb.query(`
              INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
                                    "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById",
                                    "createdAt", "updatedAt")
              VALUES ($1, $2, $3, $4, 'APPROVED', 'PREPAID', $5, $6::jsonb, $7, $4, $7, $7)
            `, [
              invoiceId, invoiceNumber, companyId, admin.id, invoiceAmount,
              JSON.stringify({
                note: 'Migrated from old worker_purchase_invoice',
                oldInvoiceId: oldInv.old_id,
                oldInvoiceNumber: oldInv.invoice_number,
                oldWorkerCount: workerCount,
                oldAmount: amount,
              }),
              invoiceDate,
            ]);

            await insertItemsAndLink(newDb, invoiceId, assignedTasks, unitPrice, invoiceDate);
          }

          totalPaidInvoices++;
          totalItemsCreated += assignedTasks.length;
          totalTasksLinked += assignedTasks.length;
        }

        // Remaining tasks after purchases → free verification invoices by month
        const remainingTasks = tasks.slice(taskCursor);
        if (remainingTasks.length > 0) {
          const monthGroups = groupByMonth(remainingTasks);
          for (const [month, monthTasks] of Object.entries(monthGroups)) {
            if (!DRY_RUN) {
              const invoiceId = cuid();
              const invoiceNumber = `MIG-FREE-${companyId}-${month}`;
              const invoiceDate = new Date(monthTasks[0].createdAt);

              await newDb.query(`
                INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
                                      "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById",
                                      "createdAt", "updatedAt")
                VALUES ($1, $2, $3, $4, 'APPROVED', 'PREPAID', $5, $6::jsonb, $7, $4, $7, $7)
              `, [
                invoiceId, invoiceNumber, companyId, admin.id, 0,
                JSON.stringify({ note: 'Free/admin verifications from legacy system', oldUserId, taskCount: monthTasks.length }),
                invoiceDate,
              ]);

              await insertItemsAndLink(newDb, invoiceId, monthTasks, 0, invoiceDate);
            }

            totalFreeInvoices++;
            totalItemsCreated += monthTasks.length;
            totalTasksLinked += monthTasks.length;
          }
        }
      } else {
        // No old purchase history → settlement invoices by month
        companiesWithoutHistory++;
        const monthGroups = groupByMonth(tasks);
        for (const [month, monthTasks] of Object.entries(monthGroups)) {
          if (!DRY_RUN) {
            const invoiceId = cuid();
            const invoiceNumber = `MIG-SETTLE-${companyId}-${month}`;
            const invoiceDate = new Date(monthTasks[0].createdAt);

            await newDb.query(`
              INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
                                    "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById",
                                    "createdAt", "updatedAt")
              VALUES ($1, $2, $3, $4, 'APPROVED', 'POSTPAID', $5, $6::jsonb, $7, $4, $7, $7)
            `, [
              invoiceId, invoiceNumber, companyId, admin.id, monthTasks.length * getUnitPrice(invoiceDate),
              JSON.stringify({ note: 'Legacy verifications — settlement' }),
              invoiceDate,
            ]);

            await insertItemsAndLink(newDb, invoiceId, monthTasks, getUnitPrice(invoiceDate), invoiceDate);
          }

          totalSettleInvoices++;
          totalItemsCreated += monthTasks.length;
          totalTasksLinked += monthTasks.length;
        }
      }

      const processed = companiesWithHistory + companiesWithoutHistory;
      if (processed % 500 === 0) {
        console.log(`  Progress: ${processed} companies, ${totalPaidInvoices} paid, ${totalFreeInvoices} free, ${totalSettleInvoices} settle, ${totalTasksLinked} tasks`);
      }
    }

    if (!DRY_RUN) {
      await newDb.query('COMMIT');
      console.log('\n✓ Committed.');
    }
  } catch (err) {
    if (!DRY_RUN) await newDb.query('ROLLBACK');
    console.error(`\n✗ ROLLBACK: ${err.message}`);
    console.error(err.stack);
    await cleanup();
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Companies with purchase history: ${companiesWithHistory}`);
  console.log(`  Companies without history (settlement): ${companiesWithoutHistory}`);
  console.log(`  Purchase invoices (MIG-WPI): ${totalPaidInvoices}`);
  console.log(`  Free invoices (MIG-FREE): ${totalFreeInvoices}`);
  console.log(`  Settlement invoices (MIG-SETTLE): ${totalSettleInvoices}`);
  console.log(`  Total invoice items: ${totalItemsCreated}`);
  console.log(`  Total tasks linked: ${totalTasksLinked}`);

  if (!DRY_RUN) {
    const { rows: [{ cnt: remaining }] } = await newDb.query(`
      SELECT COUNT(*)::int AS cnt FROM verification_tasks WHERE status = 'COMPLETED' AND "invoiceId" IS NULL
    `);
    console.log(`\n  Remaining unlinked tasks: ${remaining}`);
    const { rows: [{ cnt: totalInv }] } = await newDb.query(`SELECT COUNT(*)::int AS cnt FROM invoices`);
    console.log(`  Total invoices now: ${totalInv}`);
  }

  await cleanup();

  async function cleanup() {
    await oldDb.end();
    await newDb.end();
  }
}

function groupByMonth(tasks) {
  const groups = {};
  for (const task of tasks) {
    const d = new Date(task.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(task);
  }
  return groups;
}

async function insertItemsAndLink(newDb, invoiceId, tasks, unitPrice, invoiceDate) {
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let idx = 1;
    for (const task of batch) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(cuid(), invoiceId, task.id, unitPrice, invoiceDate);
    }
    await newDb.query(`
      INSERT INTO invoice_items (id, "invoiceId", "taskId", "unitPrice", "createdAt")
      VALUES ${values.join(', ')}
    `, params);

    const taskIds = batch.map(t => t.id);
    await newDb.query(`
      UPDATE verification_tasks SET "invoiceId" = $1 WHERE id = ANY($2::text[])
    `, [invoiceId, taskIds]);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
