const XLSX = require('xlsx');
const fs = require('fs');

const report = JSON.parse(fs.readFileSync('reconciliation_report.json', 'utf8'));
const csvText = fs.readFileSync('old_vs_new_reconciliation.csv', 'utf8');

// Parse CSV data rows
const csvLines = csvText.trim().split('\n');
const headers = csvLines[0].split(',');
const dataRows = csvLines.slice(1).map(line => {
  const vals = line.split(',');
  return vals;
});

// Stats
const negative = report.filter(r => r.ledgerBalance < 0);
const zero = report.filter(r => r.ledgerBalance === 0);
const positive = report.filter(r => r.ledgerBalance > 0);
const totalOldUnits = report.reduce((s, r) => s + r.oldUnits, 0);
const matchingUnits = report.filter(r => r.expectedFromUnits === r.creditFromLedger);
const phantomUnits = report.reduce((s, r) => {
  if (r.ledgerBalance < 0) return s + r.oldUnits;
  const ledgerUnits = Math.floor(Math.max(0, r.ledgerBalance) / 500);
  return s + Math.max(0, r.oldUnits - ledgerUnits);
}, 0);

// Build sheet data
const rows = [];

// Summary section
rows.push(['TASDEEQ OLD SYSTEM vs NEW SYSTEM — CREDIT RECONCILIATION REPORT']);
rows.push(['Generated: 2026-11-22']);
rows.push([]);
rows.push(['OVERVIEW']);
rows.push(['Total users matched', 180]);
rows.push(['Negative ledger balance (owe money but had units)', negative.length]);
rows.push(['Zero ledger balance', zero.length]);
rows.push(['Positive ledger balance', positive.length]);
rows.push(['Total old system units', totalOldUnits, '', 'PKR equivalent', totalOldUnits * 500]);
rows.push(['Phantom units (no financial backing)', phantomUnits, '', 'PKR equivalent', phantomUnits * 500]);
rows.push(['Users where units matched ledger', matchingUnits.length]);
rows.push([]);
rows.push(['WHAT WAS HAPPENING IN THE OLD SYSTEM']);
rows.push(['The old system had two separate tracking mechanisms:']);
rows.push(['1) user_available_verification — stored "available units" per user']);
rows.push(['2) verification_ledger — stored actual financial transactions (purchases & consumption)']);
rows.push([]);
rows.push(['PROBLEM: These two were NOT synchronized.']);
rows.push(['Units were MANUALLY ADDED to the DB without creating financial transactions.']);
rows.push(['Users could see 396 units as "available" while their ledger showed they OWED money.']);
rows.push(['No audit trail existed for manual unit additions.']);
rows.push([]);
rows.push(['WHAT OUR NEW SYSTEM DOES CORRECTLY']);
rows.push(['• Single source of truth: creditLimit on the Company record']);
rows.push(['• Outstanding calculated in real-time from invoices & tasks — not stored separately']);
rows.push(['• Available Credit = Credit Limit − Outstanding; Available Units = floor(Available / 500)']);
rows.push(['• Every change is audited with timestamps and actor info']);
rows.push(['• All verifications generate invoices (prepaid or postpaid) — complete financial trail']);
rows.push([]);
rows.push(['DECISION: We honored old displayed units (Old Units × 500 = Credit Limit) for all users,']);
rows.push(['even though many were not backed by actual payments. New system prevents recurrence.']);
rows.push([]);

// Top 10 worst cases
rows.push(['TOP 10 WORST CASES — INFLATED UNITS']);
rows.push(['Name', 'Phone', 'Old Units', 'Units Value (PKR)', 'Ledger Purchased', 'Ledger Consumed', 'Ledger Balance', 'Discrepancy (PKR)']);
const worst = [...negative].sort((a, b) => a.ledgerBalance - b.ledgerBalance).slice(0, 10);
for (const w of worst) {
  rows.push([w.oldName, w.phone, w.oldUnits, w.expectedFromUnits, w.ledgerPurchased, w.ledgerConsumed, w.ledgerBalance, w.expectedFromUnits - w.ledgerBalance]);
}
rows.push([]);

// Case study
rows.push(['CASE STUDY: xtrait97@gmail.com (Osama Moin Chawla)']);
const osama = report.find(r => r.phone === '03128443342');
rows.push(['Old displayed units', osama.oldUnits, '', 'Worth', osama.expectedFromUnits, 'PKR']);
rows.push(['Ledger purchased', osama.ledgerPurchased, 'PKR']);
rows.push(['Ledger consumed', osama.ledgerConsumed, 'PKR']);
rows.push(['Ledger balance', osama.ledgerBalance, 'PKR', '', 'Consumed 7x more than paid']);
rows.push(['New system invoices', osama.totalInvoices]);
rows.push(['New system total invoiced', '', '', '', 74300, 'PKR']);
rows.push(['Credit limit set (honoring old units)', osama.expectedFromUnits, 'PKR']);
rows.push([]);
rows.push([]);

// Data table header
rows.push(headers);

// Data rows
for (const dr of dataRows) {
  const parsed = dr.map(v => {
    const n = Number(v);
    if (v && !isNaN(n) && v !== 'true' && v !== 'false' && !/^cm/.test(v) && !/^\d{11}$/.test(v)) return n;
    return v;
  });
  rows.push(parsed);
}

const ws = XLSX.utils.aoa_to_sheet(rows);

// Set column widths
ws['!cols'] = [
  { wch: 30 }, { wch: 25 }, { wch: 15 }, { wch: 15 }, { wch: 15 },
  { wch: 18 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 12 },
  { wch: 45 }, { wch: 28 }, { wch: 25 }, { wch: 12 }, { wch: 20 },
  { wch: 20 }, { wch: 14 }, { wch: 20 }, { wch: 16 }, { wch: 20 },
  { wch: 14 }, { wch: 20 },
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Credit Reconciliation');
XLSX.writeFile(wb, 'tasdeeq_credit_reconciliation.xlsx');
console.log('Done: tasdeeq_credit_reconciliation.xlsx');
