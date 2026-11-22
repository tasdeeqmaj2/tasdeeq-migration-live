const { Client } = require('pg');
const fs = require('fs');

async function main() {
  const client = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', password: '12345678', database: 'tasdeeq' });
  await client.connect();

  // Get all companies with creditLimit from the new DB
  const { rows: companies } = await client.query(`
    SELECT c.id, c.name, c."creditLimit", c."isConsumer",
      (SELECT count(*) FROM verification_tasks vt WHERE vt."companyId" = c.id AND vt.status IN ('PENDING','ASSIGNED','COMPLETED') AND vt."invoiceId" IS NULL) as uninvoiced_tasks,
      (SELECT COALESCE(sum(i."totalAmount"), 0) FROM invoices i WHERE i."companyId" = c.id AND i."paymentMode" = 'POSTPAID' AND i.status IN ('PENDING_PAYMENT','PAYMENT_SUBMITTED')) as postpaid_outstanding,
      (SELECT count(*) FROM verification_tasks vt WHERE vt."companyId" = c.id) as total_tasks,
      (SELECT count(*) FROM invoices i WHERE i."companyId" = c.id) as total_invoices
    FROM companies c
    WHERE c."creditLimit" IS NOT NULL AND c."creditLimit" > 0
    ORDER BY c."creditLimit" DESC
  `);
  console.log(`Companies with creditLimit > 0: ${companies.length}`);

  // Read UAV CSV - aggregate units per user_id
  const uavLines = fs.readFileSync('C:/Users/92306/Downloads/user_available_verification.csv', 'utf8').split('\n');
  const uavByUserId = {};
  for (let i = 1; i < uavLines.length; i++) {
    const cols = uavLines[i].replace(/"/g, '').split(',');
    if (!cols[1]) continue;
    const uid = cols[1].trim();
    const units = parseInt(cols[2]) || 0;
    if (units > 0) {
      uavByUserId[uid] = (uavByUserId[uid] || 0) + units;
    }
  }
  const totalOldUsers = Object.keys(uavByUserId).length;
  const totalOldUnits = Object.values(uavByUserId).reduce((a, b) => a + b, 0);
  console.log(`Old users with available units: ${totalOldUsers}, total units: ${totalOldUnits}`);

  // Read old user CSV to get user_id -> company name mapping
  const userLines = fs.readFileSync('C:/Users/92306/Downloads/user.csv', 'utf8').split('\n');
  console.log('User CSV header:', userLines[0].substring(0, 200));
  console.log('User CSV sample:', userLines[1]?.substring(0, 200));

  // Show company credit distribution
  console.log(`\n=== CREDIT DISTRIBUTION (new DB) ===`);
  const brackets = [
    { label: '> 1M PKR', min: 1000000 },
    { label: '100K-1M', min: 100000, max: 1000000 },
    { label: '10K-100K', min: 10000, max: 100000 },
    { label: '1K-10K', min: 1000, max: 10000 },
    { label: '< 1K', min: 0, max: 1000 },
  ];
  for (const b of brackets) {
    const filtered = companies.filter(c => {
      const cl = parseFloat(c.creditLimit);
      return cl >= b.min && (!b.max || cl < b.max);
    });
    console.log(`  ${b.label}: ${filtered.length} companies`);
  }

  console.log(`\n=== TOP 20 CREDIT LIMITS ===`);
  companies.slice(0, 20).forEach(c => {
    console.log(`  ${c.name}: ${parseFloat(c.creditLimit).toLocaleString()} PKR (consumer:${c.isConsumer}, tasks:${c.total_tasks}, invoices:${c.total_invoices})`);
  });

  console.log(`\n=== SUMMARY ===`);
  const totalCredit = companies.reduce((s, c) => s + parseFloat(c.creditLimit), 0);
  console.log(`Total creditLimit across all companies: ${totalCredit.toLocaleString()} PKR`);
  console.log(`Total old units * 500: ${(totalOldUnits * 500).toLocaleString()} PKR`);
  console.log(`Companies with tasks: ${companies.filter(c => parseInt(c.total_tasks) > 0).length}`);
  console.log(`Companies with uninvoiced tasks: ${companies.filter(c => parseInt(c.uninvoiced_tasks) > 0).length}`);

  fs.writeFileSync('./reconciliation_report.json', JSON.stringify({ companies, uavByUserId, totalOldUnits }, null, 2));
  console.log(`\nSaved to reconciliation_report.json`);
  await client.end();
}
main().catch(console.error);
