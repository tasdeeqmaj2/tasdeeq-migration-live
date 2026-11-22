const { Client } = require('pg');

async function main() {
  // Old DB on pg18 container (port 5435)
  const oldDb = new Client({ host: '127.0.0.1', port: 5435, user: 'postgres', password: '12345678', database: 'tasdeeq_old' });
  await oldDb.connect();
  console.log('Connected to old DB');

  // Get users with available units + their email/name from old DB
  const { rows: oldUsers } = await oldDb.query(`
    SELECT u.id as user_id, u.email, u.name, u.phone_number, u.role_id,
           uav.available_verification as units, uav.free_verification
    FROM user_available_verification uav
    JOIN "user" u ON u.id = uav.user_id
    WHERE uav.available_verification > 0
    ORDER BY uav.available_verification DESC
  `);
  console.log(`Old users with available units: ${oldUsers.length}`);

  // Get verification ledger balance per user from old DB
  const { rows: ledgerBalances } = await oldDb.query(`
    SELECT user_id,
      SUM(CASE WHEN transaction_type_id IN (1,2) THEN amount ELSE 0 END) as purchased,
      SUM(CASE WHEN transaction_type_id IN (3,4,5,6) THEN amount ELSE 0 END) as consumed
    FROM verification_ledger
    GROUP BY user_id
  `);
  const ledgerMap = {};
  for (const lb of ledgerBalances) {
    ledgerMap[lb.user_id] = {
      purchased: parseFloat(lb.purchased) || 0,
      consumed: parseFloat(lb.consumed) || 0,
      balance: (parseFloat(lb.purchased) || 0) - (parseFloat(lb.consumed) || 0)
    };
  }
  console.log(`Ledger entries for ${Object.keys(ledgerMap).length} users`);

  const employerMap = {};
  for (const ou of oldUsers) {
    employerMap[ou.user_id] = { user_name: ou.name, email: ou.email, phone_number: ou.phone_number };
  }

  await oldDb.end();

  // Now connect to new DB - try port 5433 first, then 5434
  let newDb;
  for (const port of [5433, 5434]) {
    try {
      newDb = new Client({ host: '127.0.0.1', port, user: 'postgres', password: '12345678', database: 'tasdeeq' });
      await newDb.connect();
      console.log(`Connected to new DB on port ${port}`);
      break;
    } catch (e) {
      // Try tasdeeq credentials
      try {
        newDb = new Client({ host: '127.0.0.1', port, user: 'tasdeeq', password: 'tasdeeq_dev', database: 'tasdeeq' });
        await newDb.connect();
        console.log(`Connected to new DB on port ${port} (tasdeeq user)`);
        break;
      } catch (e2) {
        console.log(`Port ${port} failed`);
        newDb = null;
      }
    }
  }

  if (!newDb) {
    console.log('\nCannot connect to new DB. Printing old DB analysis only.\n');
    printOldDbAnalysis(oldUsers, ledgerMap, employerMap);
    return;
  }

  // Match old users to new companies by email
  const results = [];
  let matched = 0, unmatched = 0;

  for (const ou of oldUsers) {
    const emp = employerMap[ou.user_id] || {};
    const email = ou.email;
    if (!email) { unmatched++; continue; }

    // Find company in new DB via corporate_users -> companies join, matching by email
    const { rows } = await newDb.query(`
      SELECT c.id, c.name, c."creditLimit", c."isConsumer",
        (SELECT count(*) FROM verification_tasks vt WHERE vt."companyId" = c.id) as total_tasks,
        (SELECT count(*) FROM invoices i WHERE i."companyId" = c.id) as total_invoices,
        (SELECT count(*) FROM verification_tasks vt WHERE vt."companyId" = c.id AND vt.status IN ('PENDING','ASSIGNED','COMPLETED') AND vt."invoiceId" IS NULL) as uninvoiced_tasks
      FROM companies c
      JOIN corporate_users cu ON cu."companyId" = c.id
      JOIN users u ON u.id = cu."userId"
      WHERE u.email = $1
      LIMIT 1
    `, [email]);

    if (!rows.length) { unmatched++; continue; }
    matched++;

    const r = rows[0];
    const ledger = ledgerMap[ou.user_id] || { purchased: 0, consumed: 0, balance: 0 };
    const expectedFromUnits = ou.units * 500;
    const currentLimit = parseFloat(r.creditLimit) || 0;

    results.push({
      oldUserId: ou.user_id,
      email,
      oldName: emp.company_name || emp.employer_name || ou.name,
      newCompanyId: r.id,
      newName: r.name,
      isConsumer: r.isConsumer,
      oldUnits: ou.units,
      expectedFromUnits,
      ledgerBalance: ledger.balance,
      ledgerPurchased: ledger.purchased,
      ledgerConsumed: ledger.consumed,
      currentCreditLimit: currentLimit,
      diffFromUnits: currentLimit - expectedFromUnits,
      diffFromLedger: currentLimit - ledger.balance,
      totalTasks: parseInt(r.total_tasks),
      totalInvoices: parseInt(r.total_invoices),
      uninvoicedTasks: parseInt(r.uninvoiced_tasks),
    });
  }

  results.sort((a, b) => Math.abs(b.diffFromUnits) - Math.abs(a.diffFromUnits));

  console.log(`\n=== RECONCILIATION REPORT ===`);
  console.log(`Old users with units: ${oldUsers.length}`);
  console.log(`Matched to new DB: ${matched}`);
  console.log(`Unmatched: ${unmatched}`);
  console.log(`creditLimit MATCHES units*500: ${results.filter(r => r.diffFromUnits === 0).length}`);
  console.log(`creditLimit MATCHES ledger balance: ${results.filter(r => r.diffFromLedger === 0).length}`);
  console.log(`NO creditLimit set: ${results.filter(r => r.currentCreditLimit === 0).length}`);

  console.log(`\n--- Top 20 mismatches (units*500 vs creditLimit) ---`);
  results.filter(r => r.diffFromUnits !== 0).slice(0, 20).forEach(r => {
    console.log(`  ${r.newName} (old:${r.oldUserId}, email:${r.email})`);
    console.log(`    units:${r.oldUnits} units*500:${r.expectedFromUnits} ledger:${r.ledgerBalance} current:${r.currentCreditLimit}`);
    console.log(`    diffFromUnits:${r.diffFromUnits} diffFromLedger:${r.diffFromLedger}`);
    console.log(`    tasks:${r.totalTasks} invoices:${r.totalInvoices}`);
  });

  console.log(`\n--- No creditLimit set but have old units ---`);
  results.filter(r => r.currentCreditLimit === 0).slice(0, 15).forEach(r => {
    console.log(`  ${r.newName}: ${r.oldUnits} units (${r.expectedFromUnits} PKR), ledger:${r.ledgerBalance}, tasks:${r.totalTasks}`);
  });

  console.log(`\n--- Summary ---`);
  const totalExpected = results.reduce((s, r) => s + r.expectedFromUnits, 0);
  const totalCurrent = results.reduce((s, r) => s + r.currentCreditLimit, 0);
  const totalLedger = results.reduce((s, r) => s + r.ledgerBalance, 0);
  console.log(`Total expected (units*500): ${totalExpected.toLocaleString()} PKR`);
  console.log(`Total ledger balance: ${totalLedger.toLocaleString()} PKR`);
  console.log(`Total current creditLimit: ${totalCurrent.toLocaleString()} PKR`);

  require('fs').writeFileSync('./reconciliation_report.json', JSON.stringify(results, null, 2));
  console.log(`\nFull report: reconciliation_report.json (${results.length} records)`);

  await newDb.end();
}

function printOldDbAnalysis(oldUsers, ledgerMap, employerMap) {
  console.log(`=== OLD DB ANALYSIS (no new DB connection) ===`);
  console.log(`Users with units: ${oldUsers.length}`);

  const withLedger = oldUsers.filter(u => ledgerMap[u.user_id]);
  console.log(`Users also in ledger: ${withLedger.length}`);

  console.log(`\n--- Top 20 by units ---`);
  oldUsers.slice(0, 20).forEach(u => {
    const emp = employerMap[u.user_id] || {};
    const ledger = ledgerMap[u.user_id] || { balance: 0 };
    console.log(`  ${emp.company_name || u.name || u.email} (uid:${u.user_id})`);
    console.log(`    units:${u.units} units*500:${u.units * 500} ledger:${ledger.balance} email:${u.email}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
