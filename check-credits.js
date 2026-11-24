/**
 * Diagnose credit limits: compare ALL old DB users (from user_available_verification)
 * against their corresponding new DB companies.
 *
 * Old DB: user_available_verification.available_units, total_units, used_units
 * New DB: companies.creditLimit (should be available_units * 500 or total_units * 500)
 */
require('dotenv').config();
const { Client } = require('pg');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!NEW_DB_URL || !OLD_DB_URL) { console.error('Set both DB URLs in .env'); process.exit(1); }
const SSL = { rejectUnauthorized: false };

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await newDb.connect();
  await oldDb.connect();

  // 1. Check old DB columns
  console.log('=== OLD DB user_available_verification COLUMNS ===');
  const { rows: cols } = await oldDb.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'user_available_verification'
    ORDER BY ordinal_position
  `);
  console.log('Columns:', cols.map(c => c.column_name).join(', '));

  // 2. Get ALL old users with available units
  console.log('\n=== ALL OLD USERS WITH AVAILABLE UNITS ===');
  const { rows: oldUsers } = await oldDb.query(`
    SELECT uav.user_id AS id, u.name, u.email, u.phone_number AS phone,
           uav.available_verification, uav.free_verification, uav.is_active
    FROM user_available_verification uav
    JOIN "user" u ON u.id = uav.user_id
    WHERE uav.available_verification > 0 OR uav.free_verification > 0
    ORDER BY uav.available_verification DESC NULLS LAST
  `);
  console.log(`Found ${oldUsers.length} old users with units\n`);

  console.log('═'.repeat(120));
  console.log(
    'Old User'.padEnd(25) + ' | ' +
    'OldAvail'.padStart(8) + ' | ' +
    'OldFree'.padStart(8) + ' | ' +
    'New Company'.padEnd(28) + ' | ' +
    'NewCreditLimit'.padStart(14) + ' | ' +
    'Expected(A*500)'.padStart(15) + ' | ' +
    'Match?'
  );
  console.log('═'.repeat(120));

  let matched = 0, mismatches = 0, notFound = 0;

  for (const u of oldUsers) {
    const oldAvail = parseInt(u.available_verification || '0');
    const oldFree = parseInt(u.free_verification || '0');

    // Find new company via migrated email, phone, or email
    const migratedEmail = `migrated-${u.id}@consumer.tasdeeq.app`;
    let company = null;

    // Try migrated email pattern
    const { rows: byMigratedEmail } = await newDb.query(`
      SELECT c.id, c.name, c."creditLimit", c."isConsumer"
      FROM companies c
      JOIN corporate_users cu ON cu."companyId" = c.id
      JOIN users u ON u.id = cu."userId"
      WHERE u.email = $1
      LIMIT 1
    `, [migratedEmail]);
    if (byMigratedEmail.length > 0) company = byMigratedEmail[0];

    // Try by phone
    if (!company && u.phone) {
      const phones = [u.phone, u.phone.replace(/^0/, '+92')];
      const { rows: byPhone } = await newDb.query(`
        SELECT c.id, c.name, c."creditLimit", c."isConsumer"
        FROM companies c
        JOIN corporate_users cu ON cu."companyId" = c.id AND cu.role = 'OWNER'
        JOIN users u ON u.id = cu."userId"
        WHERE u.phone = ANY($1::text[]) AND c."isConsumer" = false
        LIMIT 1
      `, [phones]);
      if (byPhone.length > 0) company = byPhone[0];
    }

    // Try by email
    if (!company && u.email) {
      const { rows: byEmail } = await newDb.query(`
        SELECT c.id, c.name, c."creditLimit", c."isConsumer"
        FROM companies c
        JOIN corporate_users cu ON cu."companyId" = c.id AND cu.role = 'OWNER'
        JOIN users u ON u.id = cu."userId"
        WHERE LOWER(u.email) = LOWER($1) AND c."isConsumer" = false
        LIMIT 1
      `, [u.email]);
      if (byEmail.length > 0) company = byEmail[0];
    }

    if (!company) {
      notFound++;
      console.log(
        `${(u.name || 'N/A').substring(0, 24).padEnd(25)} | ` +
        `${String(oldAvail).padStart(8)} | ` +
        `${String(oldFree).padStart(8)} | ` +
        `${'NOT FOUND'.padEnd(28)} | ` +
        `${'—'.padStart(14)} | ` +
        `${String(oldAvail * 500).padStart(15)} | ` +
        `—`
      );
      continue;
    }

    matched++;
    const newLimit = company.creditLimit ? parseFloat(company.creditLimit) : null;
    const expectedFromAvail = oldAvail * 500;
    const expectedFromFree = oldFree * 500;
    const expectedFromTotal = (oldAvail + oldFree) * 500;

    let matchStr;
    if (newLimit === null && oldAvail === 0) matchStr = '✓ both 0';
    else if (newLimit === expectedFromAvail) matchStr = '✓ avail*500';
    else if (newLimit === expectedFromFree) matchStr = '~ free*500';
    else if (newLimit === expectedFromTotal) matchStr = '~ (a+f)*500';
    else { matchStr = '✗ MISMATCH'; mismatches++; }

    console.log(
      `${(u.name || 'N/A').substring(0, 24).padEnd(25)} | ` +
      `${String(oldAvail).padStart(8)} | ` +
      `${String(oldFree).padStart(8)} | ` +
      `${company.name.substring(0, 27).padEnd(28)} | ` +
      `${String(newLimit ?? 'NULL').padStart(14)} | ` +
      `${String(expectedFromAvail).padStart(15)} | ` +
      `${matchStr}`
    );
  }

  console.log(`\n${'═'.repeat(120)}`);
  console.log(`Matched: ${matched}, Not found: ${notFound}, Mismatches: ${mismatches}`);

  // Also show all new companies WITH credit limits
  console.log('\n=== ALL NEW DB COMPANIES WITH CREDIT LIMITS ===');
  const { rows: allCredit } = await newDb.query(`
    SELECT c.id, c.name, c."creditLimit", c."isConsumer"
    FROM companies c
    WHERE c."creditLimit" IS NOT NULL
    ORDER BY c."creditLimit" DESC
  `);
  for (const c of allCredit) {
    console.log(`  ${c.name}: ${c.creditLimit} (isConsumer=${c.isConsumer})`);
  }

  await newDb.end();
  await oldDb.end();
}
run().catch(e => { console.error(e); process.exit(1); });
