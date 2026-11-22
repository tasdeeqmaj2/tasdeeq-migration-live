const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'reconciliation_report.json'), 'utf8'));

function psql(sql) {
  try {
    const escaped = sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const result = execSync(
      `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -t -A -F "|" -c "${escaped}"`,
      { encoding: 'utf8', timeout: 10000 }
    );
    return result.trim();
  } catch {
    return '';
  }
}

function getInvoiceStats(companyId) {
  if (!companyId) return { total: 0, totalAmt: 0, freeCount: 0, freeAmt: 0, paidCount: 0, paidAmt: 0 };
  const sql = `SELECT COUNT(*), COALESCE(SUM("totalAmount"),0), COUNT(*) FILTER (WHERE "invoiceNumber" LIKE 'MIG-%'), COALESCE(SUM("totalAmount") FILTER (WHERE "invoiceNumber" LIKE 'MIG-%'),0), COUNT(*) FILTER (WHERE "invoiceNumber" NOT LIKE 'MIG-%'), COALESCE(SUM("totalAmount") FILTER (WHERE "invoiceNumber" NOT LIKE 'MIG-%'),0) FROM invoices WHERE "companyId" = '${companyId}'`;
  const row = psql(sql);
  if (!row) return { total: 0, totalAmt: 0, freeCount: 0, freeAmt: 0, paidCount: 0, paidAmt: 0 };
  const parts = row.split('|');
  return {
    total: parseInt(parts[0]) || 0,
    totalAmt: parseFloat(parts[1]) || 0,
    freeCount: parseInt(parts[2]) || 0,
    freeAmt: parseFloat(parts[3]) || 0,
    paidCount: parseInt(parts[4]) || 0,
    paidAmt: parseFloat(parts[5]) || 0,
  };
}

function classifyIssue(rec) {
  const unitsValue = rec.oldUnits * 500;
  const ledger = rec.ledgerBalance;
  if (ledger < 0 && rec.oldUnits > 0) return 'CRITICAL: Units inflated - ledger shows negative balance (user owes money but had units)';
  if (ledger === 0 && rec.oldUnits > 0) return 'Units exist but ledger balance is zero';
  if (ledger > 0 && unitsValue > ledger) return 'Units higher than ledger balance (partially inflated)';
  if (ledger > 0 && unitsValue === ledger) return 'Units match ledger balance (correct)';
  if (ledger > 0 && unitsValue < ledger) return 'Units lower than ledger balance (units undercount)';
  if (rec.oldUnits === 0 && ledger > 0) return 'No units but positive ledger (units cleared but money exists)';
  if (rec.oldUnits === 0 && ledger === 0) return 'No units, no balance';
  if (rec.oldUnits === 0 && ledger < 0) return 'No units, negative ledger';
  return 'Other';
}

function ledgerStatus(balance) {
  if (balance > 0) return 'Positive';
  if (balance < 0) return 'Negative';
  return 'Zero';
}

function escapeCsv(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

console.log(`Processing ${data.length} records...`);

const headers = [
  'Old User ID', 'Name', 'Phone', 'Match Method',
  'Old System Units', 'Old Units Value (PKR)',
  'Old Ledger Purchased (PKR)', 'Old Ledger Consumed (PKR)', 'Old Ledger Balance (PKR)',
  'Ledger Status', 'Issue Found',
  'New System Company ID', 'New System Company Name', 'Is Consumer',
  'Previous Credit Limit (PKR)', 'Corrected Credit Limit (PKR)',
  'Total Invoices', 'Total Invoiced (PKR)',
  'Free (MIG) Invoices', 'Free Invoices Amount (PKR)',
  'Paid Invoices', 'Paid Invoices Amount (PKR)',
];

const rows = [];

let negCount = 0, posCount = 0, zeroCount = 0;
let totalPhantomUnits = 0;
let totalOldUnits = 0;
let worstCases = [];

for (let i = 0; i < data.length; i++) {
  const rec = data[i];
  if (i % 20 === 0) console.log(`  ${i + 1}/${data.length}...`);

  const inv = getInvoiceStats(rec.newCompanyId);
  const issue = classifyIssue(rec);
  const status = ledgerStatus(rec.ledgerBalance);

  if (rec.ledgerBalance < 0) negCount++;
  else if (rec.ledgerBalance > 0) posCount++;
  else zeroCount++;

  totalOldUnits += rec.oldUnits;

  if (rec.ledgerBalance <= 0 && rec.oldUnits > 0) {
    totalPhantomUnits += rec.oldUnits;
    worstCases.push(rec);
  } else if (rec.ledgerBalance > 0 && rec.oldUnits * 500 > rec.ledgerBalance) {
    const phantomPortion = rec.oldUnits - Math.floor(rec.ledgerBalance / 500);
    totalPhantomUnits += phantomPortion;
  }

  rows.push([
    rec.oldUserId,
    rec.oldName,
    rec.phone,
    rec.matchMethod,
    rec.oldUnits,
    rec.oldUnits * 500,
    rec.ledgerPurchased,
    rec.ledgerConsumed,
    rec.ledgerBalance,
    status,
    issue,
    rec.newCompanyId,
    rec.newName,
    rec.isConsumer,
    rec.currentCreditLimit,
    rec.oldUnits * 500,
    inv.total,
    inv.totalAmt,
    inv.freeCount,
    inv.freeAmt,
    inv.paidCount,
    inv.paidAmt,
  ]);
}

worstCases.sort((a, b) => a.ledgerBalance - b.ledgerBalance);

const csv = [headers.map(escapeCsv).join(','), ...rows.map(r => r.map(escapeCsv).join(','))].join('\n');
fs.writeFileSync(path.join(__dirname, 'old_vs_new_reconciliation.csv'), csv, 'utf8');
console.log(`\nCSV written: old_vs_new_reconciliation.csv (${rows.length} rows)`);

const top10 = worstCases.slice(0, 10);

const summary = `
=============================================================================
   TASDEEQ OLD SYSTEM vs NEW SYSTEM - CREDIT RECONCILIATION REPORT
=============================================================================
Generated: ${new Date().toISOString().split('T')[0]}

1. OVERVIEW
-----------
Total users matched between old and new system: ${data.length}

Ledger Balance Status:
  - Positive balance (actual credit remaining):  ${posCount} users
  - Zero balance (fully consumed):               ${zeroCount} users
  - NEGATIVE balance (consumed more than paid):   ${negCount} users

Total old system units across all users: ${totalOldUnits.toLocaleString()} units (${(totalOldUnits * 500).toLocaleString()} PKR equivalent)
Total "phantom" units (no financial backing):     ${totalPhantomUnits.toLocaleString()} units (${(totalPhantomUnits * 500).toLocaleString()} PKR equivalent)


2. WHAT WAS HAPPENING IN THE OLD SYSTEM
-----------------------------------------
The old Tasdeeq system had two separate tracking mechanisms:

  a) user_available_verification table - Stored "available units" per user
  b) verification_ledger table - Stored actual financial transactions (purchases & consumption)

THE PROBLEM: These two were NOT synchronized.

The old system allowed units to be MANUALLY ADDED directly to the
user_available_verification table WITHOUT creating corresponding financial
transactions in the verification_ledger. This means:

  - Users could have 396 units showing as "available" while their actual
    financial ledger showed they OWED money (negative balance)
  - Units were added as a database shortcut, bypassing the payment flow
  - No audit trail existed for these manual unit additions
  - The ledger (financial truth) and the units display (what users saw)
    diverged over time

This is equivalent to adding money to someone's displayed wallet balance
without them actually paying — the books don't balance.


3. WORST CASES - USERS WITH INFLATED UNITS
-------------------------------------------
These users had the largest discrepancies (units existed but ledger was negative):

${top10.map((r, i) => `  ${i + 1}. ${r.oldName} (ID: ${r.oldUserId}, Phone: ${r.phone})
     Old Units: ${r.oldUnits} (${(r.oldUnits * 500).toLocaleString()} PKR display value)
     Ledger Purchased: ${r.ledgerPurchased.toLocaleString()} PKR
     Ledger Consumed:  ${r.ledgerConsumed.toLocaleString()} PKR
     Ledger Balance:   ${r.ledgerBalance.toLocaleString()} PKR (NEGATIVE - owes money)
     Discrepancy:      ${((r.oldUnits * 500) - r.ledgerBalance).toLocaleString()} PKR`).join('\n\n')}


4. CASE STUDY: xtrait97@gmail.com (Osama Moin Chawla)
------------------------------------------------------
Old System:
  - Displayed units:    396 (worth 198,000 PKR at face value)
  - Ledger purchased:   43,800 PKR (actual money received)
  - Ledger consumed:    308,000 PKR (verifications done)
  - Ledger balance:     -264,200 PKR (NEGATIVE - consumed 7x more than paid)

New System:
  - Total invoices:     159
  - Total invoiced:     74,300 PKR
  - Free (MIG) invoices: Migrated verification history (no charge)
  - Paid invoices:      Actual paid transactions in new system
  - Credit limit set:   198,000 PKR (honoring old displayed units)

The 396 "units" in the old system were NOT backed by real payments. The user
consumed 308,000 PKR worth of verifications but only paid 43,800 PKR. The old
system continued showing 396 units because they were manually added to the DB.


5. WHAT OUR NEW SYSTEM DOES CORRECTLY
---------------------------------------
  a) SINGLE SOURCE OF TRUTH: Credit limit (creditLimit) is one field on the
     Company record. No separate "units" table that can go out of sync.

  b) AUTOMATIC TRACKING: Outstanding balance is calculated in real-time from
     actual invoice and verification task data — not stored separately.

  c) FORMULA: Available Credit = Credit Limit - Outstanding
     Available Units = floor(Available Credit / 500)

  d) AUDIT TRAIL: Every credit change, payment, and verification is logged
     in the audit system with timestamps and actor information.

  e) INVOICE-BASED: All verifications generate invoices (prepaid or postpaid),
     creating a complete financial trail.

  f) NO MANUAL DB EDITS: Credit limits can only be changed through the admin
     panel, which creates audit log entries.


6. DECISION MADE
-----------------
Despite the ledger discrepancies, we honored the old system's displayed units
for all ${data.length} matched users:

  Credit Limit = Old Units × 500 PKR

This ensures no user sees a reduction in their credits during migration,
even though many of these units were not backed by actual payments in the
old system's financial ledger.

Going forward, the new system prevents this discrepancy from recurring.


7. CATEGORIES BREAKDOWN
-------------------------
${(() => {
  const categories = {};
  for (const rec of data) {
    const issue = classifyIssue(rec);
    categories[issue] = (categories[issue] || 0) + 1;
  }
  return Object.entries(categories).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${v} users: ${k}`).join('\n');
})()}

=============================================================================
                           END OF REPORT
=============================================================================
`.trim();

fs.writeFileSync(path.join(__dirname, 'reconciliation_summary.txt'), summary, 'utf8');
console.log('Summary written: reconciliation_summary.txt');
