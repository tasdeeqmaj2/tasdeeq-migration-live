const { execSync } = require('child_process');
const report = require('./reconciliation_report.json');

const DRY_RUN = process.argv.includes('--dry-run');
const ADMIN_ID = 'cmwjtczfx0000ql10mtmgx1ms';

function psql(sql) {
  const escaped = sql.replace(/'/g, "''").replace(/"/g, '\\"');
  // Write SQL to temp file to avoid shell escaping issues
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpFile = path.join(os.tmpdir(), 'mig_invoice.sql');
  const containerTmp = '/tmp/mig_invoice.sql';
  fs.writeFileSync(tmpFile, sql);
  execSync(`docker cp "${tmpFile}" tasdeeq-postgres-1:${containerTmp}`);
  const result = execSync(
    `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -t -f ${containerTmp}`,
    { encoding: 'utf8' }
  );
  return result.trim();
}

function psqlDirect(sql) {
  const result = execSync(
    `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -t -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
  );
  return result.trim();
}

function generateId() {
  return 'mig_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const usersWithConsumed = report.filter(x => x.ledgerConsumed > 0 && x.newCompanyId);

console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Adding migration invoices for ${usersWithConsumed.length} users...\n`);

let created = 0;
let skipped = 0;
let totalAmount = 0;

for (const user of usersWithConsumed) {
  const invoiceNumber = `MIG-LEGACY-${user.oldUserId}`;

  // Check if already exists
  const exists = psqlDirect(
    `SELECT COUNT(*) FROM invoices WHERE "invoiceNumber" = '${invoiceNumber}'`
  );
  if (parseInt(exists.trim()) > 0) {
    console.log(`SKIP ${user.oldName} — ${invoiceNumber} already exists`);
    skipped++;
    continue;
  }

  // Check company exists
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

  console.log(`${DRY_RUN ? '[DRY] ' : ''}CREATE ${invoiceNumber} for ${user.oldName}: Rs. ${amount.toLocaleString()} (old system consumed)`);

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
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpFile = path.join(os.tmpdir(), 'mig_invoice.sql');
    const containerTmp = '/tmp/mig_invoice.sql';
    fs.writeFileSync(tmpFile, sql);
    execSync(`docker cp "${tmpFile}" tasdeeq-postgres-1:${containerTmp}`);
    execSync(
      `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -f ${containerTmp}`,
      { encoding: 'utf8' }
    );
  }

  created++;
  totalAmount += amount;
}

console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`);
console.log(`Total legacy amount: Rs. ${totalAmount.toLocaleString()}`);
