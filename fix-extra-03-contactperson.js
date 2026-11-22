/**
 * Fix contactPerson with extra "03" prefix
 *
 * Problem: Some companies have contactPerson = "03" + phone (13 digits)
 *          e.g. "0303132642613" should be "03132642613"
 *
 * Fix: strip the leading "03" from 13-digit contactPerson values → 11 digits
 *
 * Usage:
 *   node fix-extra-03-contactperson.js --dry-run          # preview (local docker)
 *   node fix-extra-03-contactperson.js                    # apply (local docker)
 *   node fix-extra-03-contactperson.js --dry-run --prod   # preview (production)
 *   node fix-extra-03-contactperson.js --prod             # apply (production)
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

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${PROD ? '[PRODUCTION] ' : '[LOCAL] '}`);
console.log('Finding companies with extra "03" prefix in contactPerson (13 digits)...\n');

// Count affected
const count = psql(`
  SELECT COUNT(*) FROM companies
  WHERE LENGTH("contactPerson") = 13
    AND "contactPerson" ~ '^030[0-9]{10}$'
    AND "isConsumer" = false
`);

console.log(`Found ${count} companies with 13-digit contactPerson.\n`);

if (parseInt(count) === 0) {
  console.log('Nothing to fix.');
  process.exit(0);
}

// Show sample before fix
const sample = psql(`
  SELECT "contactPerson", SUBSTRING("contactPerson" FROM 3) AS fixed, name
  FROM companies
  WHERE LENGTH("contactPerson") = 13
    AND "contactPerson" ~ '^030[0-9]{10}$'
    AND "isConsumer" = false
  LIMIT 10
`);

console.log('Sample:');
sample.split('\n').filter(Boolean).forEach(r => {
  const [current, fixed, name] = r.split('||');
  console.log(`  ${name}: "${current}" → "${fixed}"`);
});

if (!DRY_RUN) {
  psql(`
    UPDATE companies
    SET "contactPerson" = SUBSTRING("contactPerson" FROM 3)
    WHERE LENGTH("contactPerson") = 13
      AND "contactPerson" ~ '^030[0-9]{10}$'
      AND "isConsumer" = false
  `);
  console.log(`\nUpdated ${count} companies.`);
} else {
  console.log(`\nWould update ${count} companies.`);
}
