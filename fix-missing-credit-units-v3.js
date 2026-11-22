/**
 * Fix companies missing credit units from old system
 *
 * This script:
 * 1. Applies all 173 entries from fix_units_credit.json (skips already-correct ones)
 * 2. Applies additional manually-added companies not in the reconciliation
 *
 * Usage:
 *   node fix-missing-credit-units-v3.js --dry-run          # preview (local docker)
 *   node fix-missing-credit-units-v3.js                    # apply (local docker)
 *   node fix-missing-credit-units-v3.js --dry-run --prod   # preview (production)
 *   node fix-missing-credit-units-v3.js --prod             # apply (production)
 */

const { execSync } = require('child_process');

const DRY_RUN = process.argv.includes('--dry-run');
const PROD = process.argv.includes('--prod');

function psql(sql) {
  const escaped = sql.replace(/\n/g, ' ');
  if (PROD) {
    require('dotenv').config();
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) { console.error('DATABASE_URL not set'); process.exit(1); }
    return execSync(
      `psql "${dbUrl}" -t -A -F "||" -c ${JSON.stringify(escaped)}`,
      { encoding: 'utf8' }
    ).trim();
  }
  return execSync(
    `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -t -A -F "||" -c "${escaped.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();
}

// ============================================================
// PART 1: Companies from fix_units_credit.json (by companyId)
// ============================================================
const fixList = require('./fix_units_credit.json');

// ============================================================
// PART 2: Additional companies missed entirely (lookup by email)
// Add more entries here as needed.
// ============================================================
const EXTRA_COMPANIES = [
  { email: 'adnan@hrspl.com.pk', oldUnits: 19, name: 'HRSI' },
  // { email: 'someone@example.com', oldUnits: 10, name: 'Company Name' },
];

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${PROD ? '[PRODUCTION] ' : '[LOCAL] '}`);
console.log(`Part 1: ${fixList.length} companies from fix_units_credit.json`);
console.log(`Part 2: ${EXTRA_COMPANIES.length} additional companies\n`);

let updated = 0;
let skipped = 0;
let notFound = 0;

// --- PART 1: By companyId ---
console.log('=== PART 1: Reconciliation fix list ===\n');

for (const item of fixList) {
  const row = psql(`SELECT COALESCE("creditLimit", 0) FROM companies WHERE id = '${item.companyId}'`);

  if (!row) {
    console.log(`NOT FOUND  ${item.name} (${item.companyId})`);
    notFound++;
    continue;
  }

  const current = Number(row);

  if (current >= item.newCreditLimit) {
    skipped++;
    continue;
  }

  console.log(`${DRY_RUN ? '[DRY] ' : ''}UPDATE ${item.name}: ${current} → ${item.newCreditLimit} (${item.oldUnits} old units)`);

  if (!DRY_RUN) {
    psql(`UPDATE companies SET "creditLimit" = ${item.newCreditLimit} WHERE id = '${item.companyId}'`);
  }

  updated++;
}

console.log(`\nPart 1 done. Updated: ${updated}, Skipped (already correct): ${skipped}, Not found: ${notFound}\n`);

// --- PART 2: By email ---
console.log('=== PART 2: Additional companies (by email) ===\n');

let updated2 = 0;
let skipped2 = 0;

for (const item of EXTRA_COMPANIES) {
  const row = psql(`
    SELECT c.id, c.name, COALESCE(c."creditLimit", 0) AS credit
    FROM companies c
    JOIN corporate_users cu ON cu."companyId" = c.id AND (cu.role = 'OWNER' OR cu."isAdmin" = true)
    JOIN users u ON u.id = cu."userId"
    WHERE u.email = '${item.email.replace(/'/g, "''")}'
    LIMIT 1
  `);

  if (!row) {
    console.log(`NOT FOUND  ${item.name} (${item.email})`);
    skipped2++;
    continue;
  }

  const [companyId, companyName, currentCredit] = row.split('||');
  const addAmount = item.oldUnits * 500;
  const newCredit = Number(currentCredit) + addAmount;

  if (Number(currentCredit) >= newCredit) {
    console.log(`SKIP  ${companyName} — already at ${currentCredit}`);
    skipped2++;
    continue;
  }

  console.log(`${DRY_RUN ? '[DRY] ' : ''}UPDATE ${companyName} (${companyId})`);
  console.log(`       email: ${item.email}`);
  console.log(`       old units: ${item.oldUnits} → add ${addAmount} PKR`);
  console.log(`       creditLimit: ${currentCredit} → ${newCredit}\n`);

  if (!DRY_RUN) {
    psql(`UPDATE companies SET "creditLimit" = ${newCredit} WHERE id = '${companyId}'`);
  }

  updated2++;
}

console.log(`\nPart 2 done. Updated: ${updated2}, Skipped: ${skipped2}`);
console.log(`\n=== TOTAL: Updated ${updated + updated2}, Skipped ${skipped + skipped2}, Not found ${notFound} ===`);
