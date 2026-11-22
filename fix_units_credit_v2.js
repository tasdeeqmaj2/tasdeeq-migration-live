const { execSync } = require('child_process');
const fixList = require('./fix_units_credit.json');

const DRY_RUN = process.argv.includes('--dry-run');

function psql(sql) {
  const result = execSync(
    `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -t -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  );
  return result.trim();
}

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Fixing ${fixList.length} companies (v2 - handles NULL creditLimit)...\n`);

let updated = 0;
let skipped = 0;
let totalCredit = 0;

for (const item of fixList) {
  // Check company exists using COUNT instead of selecting creditLimit
  const exists = psql(`SELECT COUNT(*) FROM companies WHERE id = '${item.companyId}'`);
  if (parseInt(exists) === 0) {
    console.log(`SKIP ${item.name} (${item.companyId}) — company not found`);
    skipped++;
    continue;
  }

  const currentRaw = psql(`SELECT COALESCE("creditLimit", 0) FROM companies WHERE id = '${item.companyId}'`);
  const current = Number(currentRaw);

  if (current === item.newCreditLimit) {
    console.log(`SKIP ${item.name} — already at ${item.newCreditLimit}`);
    skipped++;
    continue;
  }

  console.log(`${DRY_RUN ? '[DRY] ' : ''}UPDATE ${item.name}: ${current} → ${item.newCreditLimit} (${item.oldUnits} units)`);

  if (!DRY_RUN) {
    psql(`UPDATE companies SET "creditLimit" = ${item.newCreditLimit} WHERE id = '${item.companyId}'`);
  }

  updated++;
  totalCredit += item.newCreditLimit;
}

console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}, Total credit set: ${totalCredit.toLocaleString()} PKR`);
