/**
 * Migrate credit balances from old system to new system.
 *
 * Logic:
 * 1. For each old user, read remaining units from user_available_verification
 *    (the source of truth in the old app, not the ledger which can be out of sync)
 * 2. Reset all existing paidBalance to 0 and creditLimit to NULL
 * 3. Set paidBalance = available_verification × 500 for matched companies (if > 0)
 * 4. Create/update a "Migration Payment" invoice (APPROVED, POSTPAID) as audit trail
 *
 * Idempotent — updates existing MIG-BAL invoices if they exist.
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;

const OLD_DB_URL = process.env.OLD_DATABASE_URL;
const NEW_DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
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

  // 1. Read remaining units from user_available_verification (the actual source of truth)
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
  const mapPath = path.join(__dirname, 'maps', 'userMap.json');
  if (fs.existsSync(mapPath)) {
    userMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    console.log(`Loaded userMap: ${Object.keys(userMap).length} entries\n`);
  }

  // 4. Reset all paidBalance and creditLimit first
  console.log('=== Resetting existing balances ===\n');

  if (!DRY_RUN) {
    const { rowCount: r1 } = await newDb.query(`UPDATE companies SET "paidBalance" = 0 WHERE "paidBalance" > 0`);
    const { rowCount: r2 } = await newDb.query(`UPDATE companies SET "creditLimit" = NULL WHERE "creditLimit" IS NOT NULL AND "creditLimit" > 0`);
    console.log(`Reset ${r1} companies' paidBalance to 0, ${r2} companies' creditLimit to NULL\n`);
  } else {
    const { rows: [{ pb }] } = await newDb.query(`SELECT COUNT(*)::int AS pb FROM companies WHERE "paidBalance" > 0`);
    const { rows: [{ cl }] } = await newDb.query(`SELECT COUNT(*)::int AS cl FROM companies WHERE "creditLimit" IS NOT NULL AND "creditLimit" > 0`);
    console.log(`[DRY] Would reset ${pb} companies' paidBalance, ${cl} companies' creditLimit\n`);
  }

  // 5. Match and set
  console.log('=== Matching and setting paidBalance ===\n');

  let matched = 0, notFound = 0, skipped = 0, updated = 0, totalCreditSet = 0;

  if (!DRY_RUN) await newDb.query('BEGIN');

  try {
    for (const b of validBalances) {
      const oldId = String(b.user_id);
      const remainingUnits = Number(b.remaining_units);
      const creditAmount = remainingUnits * UNIT_PRICE;

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

      // Method 3: phone
      if (!company && b.phone) {
        const phones = [b.phone, b.phone.replace(/^0/, '+92')];
        const { rows } = await newDb.query(`
          SELECT c.id, c.name FROM companies c
          JOIN corporate_users cu ON cu."companyId" = c.id AND cu.role = 'OWNER'
          JOIN users u ON u.id = cu."userId"
          WHERE u.phone = ANY($1::text[]) AND c."isConsumer" = false LIMIT 1
        `, [phones]);
        if (rows.length) company = rows[0];
      }

      // Method 4: email
      if (!company && b.email) {
        const { rows } = await newDb.query(`
          SELECT c.id, c.name FROM companies c
          JOIN corporate_users cu ON cu."companyId" = c.id AND cu.role = 'OWNER'
          JOIN users u ON u.id = cu."userId"
          WHERE LOWER(u.email) = LOWER($1) AND c."isConsumer" = false LIMIT 1
        `, [b.email]);
        if (rows.length) company = rows[0];
      }

      if (!company) {
        notFound++;
        continue;
      }

      totalCreditSet += creditAmount;

      // Check if MIG-BAL invoice already exists
      const { rows: existing } = await newDb.query(`
        SELECT id FROM invoices WHERE "companyId" = $1 AND "invoiceNumber" LIKE 'MIG-BAL-%' LIMIT 1
      `, [company.id]);

      if (existing.length > 0) {
        // Update existing invoice and paidBalance
        updated++;
        console.log(`${DRY_RUN ? '[DRY] ' : ''}UPDATE ${company.name}: ${remainingUnits} units → Rs. ${creditAmount.toLocaleString()}`);

        if (!DRY_RUN) {
          await newDb.query(`UPDATE companies SET "paidBalance" = $1 WHERE id = $2`, [creditAmount, company.id]);
          await newDb.query(`UPDATE invoices SET "totalAmount" = $1, "bankDetailsSnapshot" = $2::jsonb, "updatedAt" = $3 WHERE id = $4`, [
            creditAmount,
            JSON.stringify({
              note: 'Migration balance — remaining paid units from legacy system (from user_available_verification)',
              oldUserId: oldId,
              availableVerification: remainingUnits,
              freeVerification: Number(b.free_verification),
            }),
            new Date().toISOString(),
            existing[0].id,
          ]);
        }
        continue;
      }

      matched++;
      console.log(`${DRY_RUN ? '[DRY] ' : ''}${company.name}: ${remainingUnits} units → Rs. ${creditAmount.toLocaleString()}`);

      if (!DRY_RUN) {
        const now = new Date().toISOString();
        const invoiceId = cuid();
        const invoiceNumber = `MIG-BAL-${oldId}`;

        await newDb.query(`UPDATE companies SET "paidBalance" = $1 WHERE id = $2`, [creditAmount, company.id]);

        await newDb.query(`
          INSERT INTO invoices (id, "invoiceNumber", "companyId", "createdById", status, "paymentMode",
                                "totalAmount", "bankDetailsSnapshot", "approvedAt", "approvedById",
                                "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, 'APPROVED', 'POSTPAID', $5,
                  $6::jsonb, $7, $4, $7, $7)
        `, [
          invoiceId, invoiceNumber, company.id, admin.id, creditAmount,
          JSON.stringify({
            note: 'Migration balance — remaining paid units from legacy system (from user_available_verification)',
            oldUserId: oldId,
            availableVerification: remainingUnits,
            freeVerification: Number(b.free_verification),
          }),
          now,
        ]);
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
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  New matches: ${matched}`);
  console.log(`  Updated (existing MIG-BAL): ${updated}`);
  console.log(`  Not found in new DB: ${notFound}`);
  console.log(`  Total paidBalance set: Rs. ${totalCreditSet.toLocaleString()}`);

  if (!DRY_RUN) {
    const { rows: [{ cnt }] } = await newDb.query(`SELECT COUNT(*)::int AS cnt FROM companies WHERE "paidBalance" > 0`);
    console.log(`\n  Companies with paidBalance > 0: ${cnt}`);
    const { rows: [{ cnt: cl }] } = await newDb.query(`SELECT COUNT(*)::int AS cnt FROM companies WHERE "creditLimit" IS NOT NULL AND "creditLimit" > 0`);
    console.log(`  Companies with creditLimit > 0: ${cl} (should be 0 after reset)`);
  }

  await cleanup();

  async function cleanup() {
    await oldDb.end();
    await newDb.end();
  }
}
run().catch(e => { console.error(e); process.exit(1); });
