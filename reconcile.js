const { Client } = require('pg');
const fs = require('fs');
const employerUserIndex = require('./mappings/employerUserIndex.json');

async function main() {
  const client = new Client({
    host: '127.0.0.1', port: 5433,
    user: 'postgres', password: '12345678', database: 'tasdeeq',
  });
  await client.connect();

  // Read UAV and map via employerUserIndex (old user_id -> new companyId)
  const uavLines = fs.readFileSync('C:/Users/92306/Downloads/user_available_verification.csv', 'utf8').split('\n');
  const entries = [];
  for (let i = 1; i < uavLines.length; i++) {
    const cols = uavLines[i].replace(/"/g, '').split(',');
    if (!cols[1]) continue;
    const uid = cols[1].trim();
    const units = parseInt(cols[2]) || 0;
    const companyId = employerUserIndex[uid];
    if (units > 0 && companyId) entries.push({ uid, units, companyId });
  }

  const results = [];
  for (const { uid, units, companyId } of entries) {

    const { rows } = await client.query(`
      SELECT c.name, c."creditLimit", c."isConsumer",
        (SELECT count(*) FROM verification_tasks vt WHERE vt."companyId" = $1 AND vt.status IN ('PENDING','ASSIGNED','COMPLETED') AND vt."invoiceId" IS NULL) as uninvoiced_tasks,
        (SELECT COALESCE(sum(i."totalAmount"), 0) FROM invoices i WHERE i."companyId" = $1 AND i."paymentMode" = 'POSTPAID' AND i.status IN ('PENDING_PAYMENT','PAYMENT_SUBMITTED')) as postpaid_outstanding,
        (SELECT count(*) FROM verification_tasks vt WHERE vt."companyId" = $1) as total_tasks,
        (SELECT count(*) FROM invoices i WHERE i."companyId" = $1) as total_invoices
      FROM companies c WHERE c.id = $1
    `, [companyId]);

    if (!rows.length) continue;
    const r = rows[0];
    const expectedCredits = units * 500;
    const currentLimit = parseFloat(r.creditLimit) || 0;

    results.push({
      oldUserId: parseInt(uid), companyId, name: r.name, isConsumer: r.isConsumer,
      oldUnits: units, expectedCredits, currentCreditLimit: currentLimit,
      diff: currentLimit - expectedCredits,
      uninvoicedTasks: parseInt(r.uninvoiced_tasks),
      postpaidOutstanding: parseFloat(r.postpaid_outstanding),
      totalTasks: parseInt(r.total_tasks),
      totalInvoices: parseInt(r.total_invoices),
    });
  }

  results.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  console.log(`\n=== RECONCILIATION REPORT ===`);
  console.log(`Mapped users with available units: ${results.length}`);
  console.log(`creditLimit MATCHES expected (units*500): ${results.filter(r => r.diff === 0).length}`);
  console.log(`creditLimit DIFFERS: ${results.filter(r => r.diff !== 0).length}`);
  console.log(`NO creditLimit set (null/0): ${results.filter(r => r.currentCreditLimit === 0).length}`);
  console.log(`creditLimit > expected: ${results.filter(r => r.diff > 0).length}`);
  console.log(`creditLimit < expected: ${results.filter(r => r.diff < 0).length}`);

  console.log(`\n--- Top 15 mismatches ---`);
  results.filter(r => r.diff !== 0).slice(0, 15).forEach(r => {
    console.log(`  ${r.name} (old:${r.oldUserId}, consumer:${r.isConsumer})`);
    console.log(`    units:${r.oldUnits} expected:${r.expectedCredits} current:${r.currentCreditLimit} diff:${r.diff}`);
    console.log(`    tasks:${r.totalTasks} invoices:${r.totalInvoices} uninvoiced:${r.uninvoicedTasks}`);
  });

  console.log(`\n--- No creditLimit set ---`);
  results.filter(r => r.currentCreditLimit === 0).slice(0, 10).forEach(r => {
    console.log(`  ${r.name}: ${r.oldUnits} units (${r.expectedCredits} PKR), tasks:${r.totalTasks}`);
  });

  fs.writeFileSync('./reconciliation_report.json', JSON.stringify(results, null, 2));
  console.log(`\nSaved ${results.length} records to reconciliation_report.json`);
  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
