const { Client } = require('pg');
const fs = require('fs');

async function main() {
  const oldDb = new Client({ host: '127.0.0.1', port: 5435, user: 'postgres', password: '12345678', database: 'tasdeeq_old' });
  await oldDb.connect();
  console.log('Connected to old DB');

  const { rows: oldUsers } = await oldDb.query(`
    SELECT u.id as user_id, u.email, u.name, u.phone_number, u.role_id,
           uav.available_verification as units, uav.free_verification
    FROM user_available_verification uav
    JOIN "user" u ON u.id = uav.user_id
    WHERE uav.available_verification > 0
    ORDER BY uav.available_verification DESC
  `);
  console.log(`Old users with available units: ${oldUsers.length}`);

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
  await oldDb.end();

  // Connect to new DB
  let newDb;
  for (const [port, user, pass] of [[5433, 'postgres', '12345678'], [5433, 'tasdeeq', 'tasdeeq_dev'], [5434, 'postgres', '12345678']]) {
    try {
      newDb = new Client({ host: '127.0.0.1', port, user, password: pass, database: 'tasdeeq' });
      await newDb.connect();
      console.log(`Connected to new DB on port ${port}`);
      break;
    } catch (e) { newDb = null; }
  }
  if (!newDb) { console.error('Cannot connect to new DB'); process.exit(1); }

  // Preload all new DB users with their company for fast lookup
  const { rows: newUsers } = await newDb.query(`
    SELECT u.id as user_id, u.email, u.phone as phone,
           cu."companyId" as company_id, cu."isAdmin"
    FROM users u
    JOIN corporate_users cu ON cu."userId" = u.id
  `);
  // Build indexes: email -> company_id, phone -> company_id
  const emailIndex = {};
  const phoneIndex = {};
  for (const nu of newUsers) {
    if (nu.email) emailIndex[nu.email.toLowerCase()] = nu.company_id;
    if (nu.phone) {
      // Normalize: strip +92, leading 0, spaces, dashes
      const norm = nu.phone.replace(/[\s\-\+]/g, '').replace(/^92/, '0').replace(/^0+/, '');
      phoneIndex[norm] = nu.company_id;
    }
  }
  console.log(`New DB email index: ${Object.keys(emailIndex).length}, phone index: ${Object.keys(phoneIndex).length}`);

  const results = [];
  let matchedEmail = 0, matchedPhone = 0, unmatched = 0;
  const matchedCompanyIds = new Set();

  for (const ou of oldUsers) {
    const ledger = ledgerMap[ou.user_id] || { purchased: 0, consumed: 0, balance: 0 };
    let companyId = null;
    let matchMethod = null;

    // Try email first
    if (ou.email) {
      companyId = emailIndex[ou.email.toLowerCase()];
      if (companyId) matchMethod = 'email';
    }

    // Try phone if email didn't match
    if (!companyId && ou.phone_number) {
      const norm = ou.phone_number.replace(/[\s\-\+]/g, '').replace(/^92/, '0').replace(/^0+/, '');
      companyId = phoneIndex[norm];
      if (companyId) matchMethod = 'phone';
    }

    if (!companyId) { unmatched++; continue; }
    if (matchMethod === 'email') matchedEmail++;
    else matchedPhone++;

    // Skip if we already processed this company (multiple old users -> same company)
    if (matchedCompanyIds.has(companyId)) continue;
    matchedCompanyIds.add(companyId);

    const { rows } = await newDb.query(`
      SELECT c.id, c.name, c."creditLimit", c."isConsumer",
        (SELECT count(*) FROM verification_tasks vt WHERE vt."companyId" = c.id) as total_tasks,
        (SELECT count(*) FROM invoices i WHERE i."companyId" = c.id) as total_invoices
      FROM companies c WHERE c.id = $1
    `, [companyId]);

    if (!rows.length) continue;
    const r = rows[0];
    const expectedFromUnits = ou.units * 500;
    const currentLimit = parseFloat(r.creditLimit) || 0;
    const creditFromLedger = Math.max(0, ledger.balance);

    results.push({
      oldUserId: ou.user_id,
      email: ou.email,
      phone: ou.phone_number,
      matchMethod,
      oldName: ou.name,
      newCompanyId: r.id,
      newName: r.name,
      isConsumer: r.isConsumer,
      oldUnits: ou.units,
      expectedFromUnits,
      ledgerBalance: ledger.balance,
      ledgerPurchased: ledger.purchased,
      ledgerConsumed: ledger.consumed,
      creditFromLedger,
      currentCreditLimit: currentLimit,
      diffFromLedger: currentLimit - creditFromLedger,
      totalTasks: parseInt(r.total_tasks),
      totalInvoices: parseInt(r.total_invoices),
      needsFix: currentLimit === 0 && creditFromLedger > 0,
    });
  }

  results.sort((a, b) => b.creditFromLedger - a.creditFromLedger);

  console.log(`\n=== RECONCILIATION REPORT ===`);
  console.log(`Old users with units: ${oldUsers.length}`);
  console.log(`Matched by email: ${matchedEmail}`);
  console.log(`Matched by phone: ${matchedPhone}`);
  console.log(`Total matched: ${matchedEmail + matchedPhone}`);
  console.log(`Unmatched: ${unmatched}`);
  console.log(`Unique companies: ${results.length}`);

  const needsFix = results.filter(r => r.needsFix);
  const alreadyCorrect = results.filter(r => r.diffFromLedger === 0 && r.currentCreditLimit > 0);
  const alreadySet = results.filter(r => r.currentCreditLimit > 0);
  const noCredit = results.filter(r => r.creditFromLedger === 0);

  console.log(`\nAlready has correct creditLimit: ${alreadyCorrect.length}`);
  console.log(`Has creditLimit (any value): ${alreadySet.length}`);
  console.log(`Needs creditLimit set (ledger > 0, current = 0): ${needsFix.length}`);
  console.log(`No credit available (ledger <= 0): ${noCredit.length}`);

  console.log(`\n--- Companies needing creditLimit fix ---`);
  needsFix.forEach(r => {
    console.log(`  ${r.newName} | ledger: ${r.creditFromLedger} PKR | units: ${r.oldUnits} | tasks: ${r.totalTasks} | match: ${r.matchMethod}`);
  });

  console.log(`\n--- Already set (top 15) ---`);
  alreadySet.sort((a, b) => b.currentCreditLimit - a.currentCreditLimit).slice(0, 15).forEach(r => {
    console.log(`  ${r.newName} | current: ${r.currentCreditLimit} | ledger: ${r.creditFromLedger} | diff: ${r.diffFromLedger}`);
  });

  console.log(`\n--- Summary ---`);
  const totalNeedsFix = needsFix.reduce((s, r) => s + r.creditFromLedger, 0);
  console.log(`Total credit to set for ${needsFix.length} companies: ${totalNeedsFix.toLocaleString()} PKR`);

  // Save full report + fix list
  fs.writeFileSync('./reconciliation_report.json', JSON.stringify(results, null, 2));
  fs.writeFileSync('./fix_list.json', JSON.stringify(needsFix.map(r => ({
    companyId: r.newCompanyId,
    companyName: r.newName,
    creditLimit: r.creditFromLedger,
    oldUserId: r.oldUserId,
    oldUnits: r.oldUnits,
    ledgerBalance: r.ledgerBalance,
    matchMethod: r.matchMethod,
  })), null, 2));
  console.log(`\nSaved reconciliation_report.json (${results.length}) and fix_list.json (${needsFix.length})`);

  await newDb.end();
}

main().catch(e => { console.error(e); process.exit(1); });
