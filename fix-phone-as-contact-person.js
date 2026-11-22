/**
 * Fix companies where contactPerson is a phone number (03...)
 *
 * Usage:
 *   node fix-phone-as-contact-person.js --dry-run          # preview (local docker)
 *   node fix-phone-as-contact-person.js                    # apply (local docker)
 *   node fix-phone-as-contact-person.js --dry-run --prod   # preview (production)
 *   node fix-phone-as-contact-person.js --prod             # apply (production)
 *
 * --prod uses DATABASE_URL from .env (or set it inline).
 * Without --prod, runs via docker exec against local postgres.
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

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${PROD ? '[PRODUCTION] ' : '[LOCAL] '}Finding companies with phone numbers as contactPerson...\n`);

const rows = psql(`
  SELECT c.id, c.name, c."contactPerson", c.phone,
         u.name AS owner_name, u.email AS owner_email
  FROM companies c
  LEFT JOIN corporate_users cu ON cu."companyId" = c.id AND (cu.role = 'OWNER' OR cu."isAdmin" = true)
  LEFT JOIN users u ON u.id = cu."userId"
  WHERE c."contactPerson" ~ '^0[0-9]{9,}$'
    AND c."isConsumer" = false
  ORDER BY c.name
`);

if (!rows) {
  console.log('No companies found with phone numbers as contactPerson.');
  process.exit(0);
}

function isPhoneNumber(s) { return s && /^0\d{9,10}$/.test(s); }

const companies = rows.split('\n').filter(Boolean).map(row => {
  const [id, name, contactPerson, phone, ownerName, ownerEmail] = row.split('||');
  return { id, name, contactPerson, phone, ownerName, ownerEmail };
});

console.log(`Found ${companies.length} companies:\n`);

let fixed = 0;
let skipped = 0;

for (const co of companies) {
  const ownerOk = co.ownerName && co.ownerName !== '' && !isPhoneNumber(co.ownerName);
  const companyOk = co.name && co.name !== '' && !isPhoneNumber(co.name);
  const newContact = ownerOk ? co.ownerName : companyOk ? co.name : null;

  if (!newContact) {
    console.log(`SKIP  ${co.name} (${co.id})`);
    console.log(`      contactPerson: "${co.contactPerson}" | owner: "${co.ownerName || 'N/A'}" (${co.ownerEmail || 'N/A'})`);
    console.log(`      → No valid replacement name found\n`);
    skipped++;
    continue;
  }

  console.log(`${DRY_RUN ? '[DRY] ' : ''}FIX   ${co.name} (${co.id})`);
  console.log(`      contactPerson: "${co.contactPerson}" → "${newContact}"`);
  console.log(`      owner: ${co.ownerEmail || 'N/A'}\n`);

  if (!DRY_RUN) {
    const safeName = newContact.replace(/'/g, "''");
    psql(`UPDATE companies SET "contactPerson" = '${safeName}' WHERE id = '${co.id}'`);
  }

  fixed++;
}

console.log(`\nDone. Fixed: ${fixed}, Skipped (no valid name): ${skipped}, Total found: ${companies.length}`);
