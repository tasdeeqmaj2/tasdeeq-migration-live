/**
 * Add migration invoices for old-system consumed verifications.
 * Creates "MIG-LEGACY-xxx" invoices so outstanding balance is tracked correctly.
 *
 * Usage:
 *   node add_migration_invoices.js --dry-run          # preview (local docker)
 *   node add_migration_invoices.js                    # apply (local docker)
 *   node add_migration_invoices.js --dry-run --prod   # preview (production)
 *   node add_migration_invoices.js --prod             # apply (production)
 */

const { execSync } = require('child_process');
const report = require('./reconciliation_report.json');

const DRY_RUN = process.argv.includes('--dry-run');
const PROD = process.argv.includes('--prod');
const ADMIN_ID = 'cmwjtczfx0000ql10mtmgx1ms';

function getDbUrl() {
  if (PROD) {
    require('dotenv').config();
    const url = process.env.DATABASE_URL;
    if (!url) { console.error('Set DATABASE_URL in .env for production'); process.exit(1); }
    return url;
  }
  return null;
}

function psqlDirect(sql) {
  if (PROD) {
    const dbUrl = getDbUrl();
    return execSync(
      `psql "${dbUrl}" -t -A -c ${JSON.stringify(sql.replace(/\n/g, ' '))}`,
      { encoding: 'utf8' }
    ).trim();
  }
  return execSync(
    `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -t -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  ).trim();
}

function psqlFile(sql) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpFile = path.join(os.tmpdir(), 'mig_invoice.sql');

  if (PROD) {
    const dbUrl = getDbUrl();
    fs.writeFileSync(tmpFile, sql);
    return execSync(`psql "${dbUrl}" -f "${tmpFile}"`, { encoding: 'utf8' }).trim();
  }

  const containerTmp = '/tmp/mig_invoice.sql';
  fs.writeFileSync(tmpFile, sql);
  execSync(`docker cp "${tmpFile}" tasdeeq-postgres-1:${containerTmp}`);
  return execSync(
    `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -f ${containerTmp}`,
    { encoding: 'utf8' }
  ).trim();
}

function generateId() {
  return 'mig_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const usersWithConsumed = report.filter(x => x.ledgerConsumed > 0 && x.newCompanyId);

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}${PROD ? '[PRODUCTION] ' : '[LOCAL] '}Adding migration invoices for ${usersWithConsumed.length} users...\n`);

let created = 0;
let skipped = 0;
let totalAmount = 0;

for (const user of usersWithConsumed) {
  const invoiceNumber = `MIG-LEGACY-${user.oldUserId}`;

  const exists = psqlDirect(
    `SELECT COUNT(*) FROM invoices WHERE "invoiceNumber" = '${invoiceNumber}'`
  );
  if (parseInt(exists.trim()) > 0) {
    skipped++;
    continue;
  }

  const companyExists = psqlDirect(
    `SELECT COUNT(*) FROM companies WHERE id = '${user.newCompanyId}'`
  );
  if (parseInt(companyExists.trim()) === 0) {
    console.log(`SKIP ${user.oldName} — company ${user.newCompanyId} not found`);
    skipped++;
    continue;
  }

  const id = generateId();
  const amount = user.ledgerConsumed;

  if (created < 20 || amount > 50000) {
    console.log(`${DRY_RUN ? '[DRY] ' : ''}CREATE ${invoiceNumber} for ${user.oldName}: Rs. ${amount.toLocaleString()}`);
  }

  if (!DRY_RUN) {
    const sql = `INSERT INTO invoices (id, "invoiceNumber", "totalAmount", "companyId", "createdById", status, "paymentMode", "bankDetailsSnapshot", "createdAt", "updatedAt", "approvedAt")
VALUES (
  '${id}',
  '${invoiceNumber}',
  ${amount},
  '${user.newCompanyId}',
  '${ADMIN_ID}',
  'APPROVED',
  'PREPAID',
  '{"note": "Legacy migration invoice - old system consumed amount"}',
  '2024-01-01 00:00:00',
  '2024-01-01 00:00:00',
  '2024-01-01 00:00:00'
);`;
    psqlFile(sql);
  }

  created++;
  totalAmount += amount;
}

console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`);
console.log(`Total legacy amount: Rs. ${totalAmount.toLocaleString()}`);
