/**
 * Migrate credit balances from old system to new system.
 *
 * Logic:
 * 1. Set creditLimit = 0 for ALL companies
 * 2. Read remaining units from old user_available_verification
 * 3. Set paidBalance = remainingUnits × 500 on matched companies (represents available units as money)
 * 4. Create a migration payment invoice (MIG-BAL-*) per user as audit trail
 *
 * Business rules:
 * - paidBalance = old available_verification × 500 (monetary value of remaining units)
 * - creditLimit is reset to 0; future credit assignments convert to units and add on top
 * - Migration payment invoice = paidBalance amount as audit trail
 *
 * Idempotent — updates existing MIG-BAL invoices and credit_statuses if re-run.
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

const UNIT_PRICE = 500;
const MAX_REASONABLE_UNITS = 50000;

function cuid() {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}

async function run() {
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  await oldDb.connect();
  await newDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);

  // 1. Read remaining units from old DB
  console.log('=== Reading available units from old DB (user_available_verification) ===\n');

  const { rows: balances } = await oldDb.query(`
    SELECT
      uav.user_id,
      u.name,
      u.email,
      u.phone_number AS phone,
      uav.available_verification AS remaining_units,
      uav.free_verification
    FROM user_available_verification uav
    JOIN "user" u ON u.id = uav.user_id
    WHERE uav.available_verification > 0
    ORDER BY uav.available_verification DESC
  `);

  const validBalances = balances.filter(b => {
    const units = Number(b.remaining_units);
    if (units > MAX_REASONABLE_UNITS) {
      console.log(`  SKIP (unreasonable): ${b.name} — ${units} units`);
      return false;
    }
    return true;
  });

  console.log(`\nOld users with remaining units: ${balances.length} (valid: ${validBalances.length})\n`);

  // 2. Find super_admin for createdById
  const { rows: [admin] } = await newDb.query(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
  if (!admin) { console.error('No super_admin found'); await cleanup(); return; }

  // 3. Load userMap if exists
  const fs = require('fs');
  const path = require('path');
  let userMap = {};
  const mapPath = path.join(__dirname, 'mappings', 'userMap.json');
  if (fs.existsSync(mapPath)) {
    userMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    console.log(`Loaded userMap: ${Object.keys(userMap).length} entries\n`);
  }

  // 4. Reset creditLimit to 0 for all companies
  console.log('=== Resetting credit limits ===\n');

  if (!DRY_RUN) {
    const { rowCount: r1 } = await newDb.query(`UPDATE companies SET "creditLimit" = 0 WHERE "creditLimit" IS NULL OR "creditLimit" > 0`);
    const { rowCount: r2 } = await newDb.query(`UPDATE companies SET "paidBalance" = 0 WHERE "paidBalance" > 0`);
    console.log(`Reset ${r1} companies' creditLimit to 0, ${r2} companies' paidBalance to 0\n`);
  } else {
    const { rows: [{ cl }] } = await newDb.query(`SELECT COUNT(*)::int AS cl FROM companies WHERE "creditLimit" IS NULL OR "creditLimit" > 0`);
    const { rows: [{ pb }] } = await newDb.query(`SELECT COUNT(*)::int AS pb FROM companies WHERE "paidBalance" > 0`);
    console.log(`[DRY] Would reset ${cl} companies' creditLimit to 0, ${pb} companies' paidBalance to 0\n`);
  }

  // 5. Match old users to new companies and set availableUnits
  console.log('=== Matching and setting availableUnits ===\n');

  let matched = 0, notFound = 0, updated = 0, totalUnitsSet = 0, totalPaymentAmount = 0;

  if (!DRY_RUN) await newDb.query('BEGIN');

  try {
    for (const b of validBalances) {
      const oldId = String(b.user_id);
      const remainingUnits = Number(b.remaining_units);
      const paymentAmount = remainingUnits * UNIT_PRICE;

      let company = null;

      // Method 1: userMap
      if (userMap[oldId]) {
        const { rows } = await newDb.query(`
          SELECT c.id, c.name FROM companies c
          JOIN corporate_users cu ON cu."companyId" = c.id
          WHERE cu."userId" = $1 LIMIT 1
        `, [userMap[oldId]]);
        if (rows.length) company = rows[0];
      }

      // Method 2: migrated email
      if (!company) {
        const migratedEmail = `migrated-${oldId}@consumer.tasdeeq.app`;
        const { rows } = await newDb.query(`
          SELECT c.id, c.name FROM companies c
          JOIN corporate_users cu ON cu."companyId" = c.id
          JOIN users u ON u.id = cu."userId"
          WHERE u.email = $1 LIMIT 1
        `, [migratedEmail]);
        if (rows.length) company = rows[0];
      }

      // Method 3: phone (decrypt first)
      if (!company && b.phone) {
        const decPhone = decryptIfEncrypted(b.phone);
        if (decPhone && /^\d/.test(decPhone)) {
          const phones = [decPhone, decPhone.replace(/^0/, '+92')];
          const { rows } = await newDb.query(`
            SELECT c.id, c.name FROM companies c
            JOIN corporate_users cu ON cu."companyId" = c.id
            JOIN users u ON u.id = cu."userId"
            WHERE u.phone = ANY($1::text[]) LIMIT 1
          `, [phones]);
          if (rows.length) company = rows[0];
        }
      }

      // Method 4: email (decrypt first)
      if (!company && b.email) {
        const decEmail = decryptIfEncrypted(b.email);
        if (decEmail && decEmail.includes('@')) {
          const { rows } = await newDb.query(`
            SELECT c.id, c.name FROM companies c
            JOIN corporate_users cu ON cu."companyId" = c.id
            JOIN users u ON u.id = cu."userId"
            WHERE LOWER(u.email) = LOWER($1) LIMIT 1
          `, [decEmail]);
          if (rows.length) company = rows[0];
        }
      }

      if (!company) {
        notFound++;
        continue;
      }

      totalUnitsSet += remainingUnits;
      totalPaymentAmount += paymentAmount;

      // Check if MIG-BAL invoice already exists for this old user (may be on a different company after reconciliation)
      const invoiceNumber = `MIG-BAL-${oldId}`;
      const { rows: existingInvoice } = await newDb.query(`
        SELECT id, "companyId" FROM invoices WHERE "invoiceNumber" = $1 LIMIT 1
      `, [invoiceNumber]);

      const isUpdate = existingInvoice.length > 0;
      if (isUpdate) updated++;
      else matched++;

      const label = isUpdate ? 'UPDATE' : 'NEW';
      console.log(`${DRY_RUN ? '[DRY] ' : ''}${label} ${company.name}: ${remainingUnits} units → paidBalance Rs. ${paymentAmount.toLocaleString()}`);

      if (!DRY_RUN) {
        const now = new Date().toISOString();
        const migrationNote = JSON.stringify({
          note: 'Migration balance — remaining available units from legacy system (user_available_verification)',
          oldUserId: oldId,
          availableVerification: remainingUnits,
          freeVerification: Number(b.free_verification),
        });

        // Set paidBalance on company (units × 500)
        await newDb.query(`UPDATE companies SET "paidBalance" = $1 WHERE id = $2`, [paymentAmount, company.id]);

        // Create or update migration payment invoice
        if (isUpdate) {
          // Also move invoice to correct company if it was on a different one
          await newDb.query(`
            UPDATE invoices SET "totalAmount" = $1, "bankDetailsSnapshot" = $2::jsonb, "updatedAt" = $3, "companyId" = $5
            WHERE id = $4
          `, [paymentAmount, migrationNote, now, existingInvoice[0].id, company.id]);
          // Clear paidBalance on old company if invoice was moved
          if (existingInvoice[0].companyId !== company.id) {
            await newDb.query(`UPDATE companies SET "paidBalance" = 0 WHERE id = $1`, [existingInvoice[0].companyId]);
          }
        } else {
          const invoiceId = cuid();

          await newDb.query(`
            INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
                                  "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById",
                                  "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, 'APPROVED', 'PREPAID', $5,
                    $6::jsonb, $7, $4, $7, $7)
          `, [invoiceId, invoiceNumber, company.id, admin.id, paymentAmount, migrationNote, now]);
        }
      }
    }

    if (!DRY_RUN) {
      await newDb.query('COMMIT');
      console.log('\n✓ Committed.');
    }
  } catch (err) {
    if (!DRY_RUN) await newDb.query('ROLLBACK');
    console.error(`\n✗ ROLLBACK: ${err.message}`);
    await cleanup();
    return;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('BALANCE MIGRATION SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  New matches: ${matched}`);
  console.log(`  Updated (existing MIG-BAL): ${updated}`);
  console.log(`  Not found in new DB: ${notFound}`);
  console.log(`  Total units migrated: ${totalUnitsSet}`);
  console.log(`  Total paidBalance set: Rs. ${totalPaymentAmount.toLocaleString()}`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 6: Reconcile — move balances to real companies (with tasks)
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(60)}`);
  console.log('=== Reconciling: move balances to companies with tasks ===\n');

  const { rows: migBalAll } = await newDb.query(`
    SELECT i.id AS "invoiceId", i."invoiceNumber", i."companyId", i."totalAmount",
           i."bankDetailsSnapshot", c.name AS "companyName", c."paidBalance"
    FROM invoices i
    JOIN companies c ON c.id = i."companyId"
    WHERE i."invoiceNumber" LIKE 'MIG-BAL-%'
  `);

  let moved = 0, alreadyCorrect = 0, noTaskCompany = 0;

  if (!DRY_RUN) await newDb.query('BEGIN');

  try {
    for (const bal of migBalAll) {
      const oldUserId = bal.bankDetailsSnapshot?.oldUserId;
      if (!oldUserId) continue;

      // Check if current company has completed tasks
      const { rows: [{ cnt: currentTasks }] } = await newDb.query(`
        SELECT COUNT(*)::int AS cnt FROM verification_tasks
        WHERE "companyId" = $1 AND status = 'COMPLETED'
      `, [bal.companyId]);

      // Find the real company via decrypted email/phone (even if current has tasks)
      const { rows: oldUserRows } = await oldDb.query(`
        SELECT email, phone_number AS phone FROM "user" WHERE id = $1
      `, [oldUserId]);
      if (!oldUserRows.length) {
        if (currentTasks > 0) alreadyCorrect++;
        else noTaskCompany++;
        continue;
      }

      const decEmail = decryptIfEncrypted(oldUserRows[0].email);
      const decPhone = decryptIfEncrypted(oldUserRows[0].phone);

      let realCompany = null;

      // Try email match
      if (decEmail && decEmail.includes('@')) {
        const { rows } = await newDb.query(`
          SELECT c.id, c.name, (SELECT COUNT(*)::int FROM verification_tasks WHERE "companyId" = c.id AND status = 'COMPLETED') AS tasks
          FROM companies c
          JOIN corporate_users cu ON cu."companyId" = c.id
          JOIN users u ON u.id = cu."userId"
          WHERE LOWER(u.email) = LOWER($1) AND c.id != $2
        `, [decEmail, bal.companyId]);
        if (rows.length && rows[0].tasks > 0) realCompany = rows[0];
      }

      // Try phone match
      if (!realCompany && decPhone && /^\d/.test(decPhone)) {
        const phones = [decPhone, decPhone.replace(/^0/, '+92')];
        const { rows } = await newDb.query(`
          SELECT c.id, c.name, (SELECT COUNT(*)::int FROM verification_tasks WHERE "companyId" = c.id AND status = 'COMPLETED') AS tasks
          FROM companies c
          JOIN corporate_users cu ON cu."companyId" = c.id
          JOIN users u ON u.id = cu."userId"
          WHERE u.phone = ANY($1::text[]) AND c.id != $2
        `, [phones, bal.companyId]);
        if (rows.length && rows[0].tasks > 0) realCompany = rows[0];
      }

      // Skip if no other company found, or current company has more tasks
      if (!realCompany || realCompany.tasks <= currentTasks) {
        if (currentTasks > 0) alreadyCorrect++;
        else noTaskCompany++;
        continue;
      }

      const amount = Number(bal.totalAmount);
      console.log(`${DRY_RUN ? '[DRY] ' : ''}MOVE ${bal.companyName} → ${realCompany.name}: Rs. ${amount.toLocaleString()} (${realCompany.tasks} tasks)`);

      if (!DRY_RUN) {
        // Move MIG-BAL invoice to real company
        await newDb.query(`UPDATE invoices SET "companyId" = $1 WHERE id = $2`, [realCompany.id, bal.invoiceId]);
        // Set paidBalance on real company, clear on old
        await newDb.query(`UPDATE companies SET "paidBalance" = $1 WHERE id = $2`, [amount, realCompany.id]);
        await newDb.query(`UPDATE companies SET "paidBalance" = 0 WHERE id = $1`, [bal.companyId]);
      }

      moved++;
    }

    if (!DRY_RUN) {
      await newDb.query('COMMIT');
      console.log('\n✓ Reconciliation committed.');
    }
  } catch (err) {
    if (!DRY_RUN) await newDb.query('ROLLBACK');
    console.error(`\n✗ Reconciliation ROLLBACK: ${err.message}`);
  }

  console.log(`\n  Already correct (has tasks): ${alreadyCorrect}`);
  console.log(`  Moved to real company: ${moved}`);
  console.log(`  No real company with tasks found: ${noTaskCompany}`);

  if (!DRY_RUN) {
    const { rows: [{ cnt }] } = await newDb.query(`
      SELECT COUNT(*)::int AS cnt FROM companies WHERE "paidBalance" > 0
    `);
    console.log(`\n  Companies with paidBalance > 0: ${cnt}`);
    const { rows: [{ cnt: cl }] } = await newDb.query(`
      SELECT COUNT(*)::int AS cnt FROM companies WHERE "creditLimit" > 0
    `);
    console.log(`  Companies with creditLimit > 0: ${cl} (should be 0 after reset)`);
  }

  await cleanup();

  async function cleanup() {
    await oldDb.end();
    await newDb.end();
  }
}
run().catch(e => { console.error(e); process.exit(1); });
