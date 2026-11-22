/**
 * Apply credit fixes for ALL companies identified by find-missing-credits.js
 *
 * Sets creditLimit = oldUnits × 500 for each company.
 * Skips if current creditLimit is already >= target.
 *
 * Usage:
 *   node apply-all-credit-fixes.js --dry-run          # preview (local docker)
 *   node apply-all-credit-fixes.js                    # apply (local docker)
 *   node apply-all-credit-fixes.js --dry-run --prod   # preview (production)
 *   node apply-all-credit-fixes.js --prod             # apply (production)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const PROD = process.argv.includes('--prod');

function psql(sql) {
  const escaped = sql.replace(/\n/g, ' ');
  if (PROD) {
    require('dotenv').config();
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) { console.error('Set DATABASE_URL in .env for production'); process.exit(1); }
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

// Load fix list
const fixPath = path.join(__dirname, 'fix_units_credit_v3.json');
if (!fs.existsSync(fixPath)) {
  console.error('Run find-missing-credits.js first to generate fix_units_credit_v3.json');
  process.exit(1);
}
const fixList = JSON.parse(fs.readFileSync(fixPath, 'utf8'));

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${PROD ? '[PRODUCTION] ' : '[LOCAL] '}`);
console.log(`Processing ${fixList.length} companies...\n`);

let updated = 0;
let skipped = 0;
let notFound = 0;

for (const item of fixList) {
  const row = psql(`SELECT COALESCE("creditLimit", 0) FROM companies WHERE id = '${item.companyId}'`);

  if (!row) {
    notFound++;
    continue;
  }

  const current = Number(row);

  if (current >= item.newCreditLimit) {
    skipped++;
    continue;
  }

  if (updated < 20 || item.newCreditLimit > 50000) {
    console.log(`${DRY_RUN ? '[DRY] ' : ''}UPDATE ${item.name}: ${current} → ${item.newCreditLimit} (${item.oldUnits} units)`);
  }

  if (!DRY_RUN) {
    psql(`UPDATE companies SET "creditLimit" = ${item.newCreditLimit} WHERE id = '${item.companyId}'`);
  }

  updated++;
}

console.log(`\nDone. Updated: ${updated}, Already correct: ${skipped}, Not found: ${notFound}, Total: ${fixList.length}`);
