/**
 * Fix zero-priced MIG invoice items for ALL companies where the mapped old user
 * has no consumption ledger data, but a different old user with the same phone DOES.
 *
 * Pattern: companyMap maps old user A (no ledger) to company X,
 * but old user B (same phone, has ledger) has the actual paid history.
 *
 * Also handles: companies where the mapped old user simply has consumption data
 * that wasn't picked up by earlier fix scripts (catches any stragglers).
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { resolvePhone } = require('./utils/contactFields');
const { section, info, success, warn, flushErrors } = require('./utils/logger');

async function main() {
  section('Fix zero-priced MIG invoices by matching phones to ledger data');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap('companyMap.json');

  // Load unmapped user map
  const unmappedMapPath = path.join(__dirname, 'mappings', 'unmappedUserMap.json');
  let unmappedMap = {};
  if (fs.existsSync(unmappedMapPath)) {
    unmappedMap = JSON.parse(fs.readFileSync(unmappedMapPath, 'utf8'));
  }

  // Build companyId → oldUserId from both maps
  const companyToOldUser = {};
  for (const [oldKey, companyId] of Object.entries(companyMap)) {
    const stripped = String(oldKey).replace(/^hh-/, '');
    const num = Number(stripped);
    if (!isNaN(num)) companyToOldUser[companyId] = num;
  }
  for (const [oldUserId, data] of Object.entries(unmappedMap)) {
    const num = Number(oldUserId);
    if (!isNaN(num) && data.companyId) companyToOldUser[data.companyId] = num;
  }

  // Step 1: Find all companies with zero-priced MIG items
  section('Finding companies with zero-priced MIG items');
  const { rows: zeroCos } = await newDb.query(`
    SELECT i."companyId", COUNT(*)::int AS zero_count
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii."invoiceId"
    WHERE i."invoiceNumber" LIKE 'MIG-%'
      AND ii."unitPrice" = 0
    GROUP BY i."companyId"
    ORDER BY zero_count DESC
  `);
  info(`Companies with zero-priced MIG items: ${zeroCos.length}`);
  info(`Total zero-priced items: ${zeroCos.reduce((s, r) => s + r.zero_count, 0)}`);

  // Step 2: Load ALL old user phones
  section('Loading old user phones');
  const { rows: oldUsers } = await oldDb.query(`
    SELECT id, phone_number FROM "user"
    WHERE phone_number IS NOT NULL AND phone_number != ''
  `);

  // Build phone → [oldUserIds] (multiple old accounts can share a phone)
  const phoneToOldUsers = {};
  const oldUserToPhone = {};
  for (const u of oldUsers) {
    const phone = resolvePhone(u.phone_number, { migration: 'fix_price_phone' });
    if (phone && phone.length >= 10) {
      if (!phoneToOldUsers[phone]) phoneToOldUsers[phone] = [];
      phoneToOldUsers[phone].push(Number(u.id));
      oldUserToPhone[Number(u.id)] = phone;
    }
  }
  info(`Old users with phones: ${Object.keys(oldUserToPhone).length}`);

  // Step 3: For each company, find the new DB user's phone
  section('Matching companies to ledger data via phone');
  let totalFixed = 0;
  let totalInvoicesRecalced = 0;
  let companiesFixed = 0;
  let companiesSkippedNoPhone = 0;
  let companiesSkippedNoAltUser = 0;
  let companiesSkippedNoLedger = 0;

  for (let ci = 0; ci < zeroCos.length; ci++) {
    const { companyId, zero_count } = zeroCos[ci];
    const mappedOldUser = companyToOldUser[companyId];

    // First try: does the mapped old user have consumption data we missed?
    if (mappedOldUser) {
      const { rows: cons } = await oldDb.query(`
        SELECT amount, quantity, date
        FROM verification_ledger
        WHERE user_id = $1 AND transaction_type_id IN (3, 4, 5, 6)
        ORDER BY date ASC
      `, [mappedOldUser]);

      if (cons.length > 0) {
        const result = await fixCompanyPricing(newDb, companyId, cons);
        if (result.updated > 0) {
          totalFixed += result.updated;
          totalInvoicesRecalced += result.invoices;
          companiesFixed++;
          if ((companiesFixed % 50) === 0) info(`  Progress: ${companiesFixed} companies fixed`);
          continue;
        }
      }
    }

    // Second try: find user phone from new DB, look up alternate old users
    const { rows: companyUsers } = await newDb.query(`
      SELECT u.phone FROM users u
      JOIN corporate_users cu ON cu."userId" = u.id
      WHERE cu."companyId" = $1 AND u.phone IS NOT NULL
      LIMIT 1
    `, [companyId]);

    if (!companyUsers.length || !companyUsers[0].phone) {
      companiesSkippedNoPhone++;
      continue;
    }

    const phone = companyUsers[0].phone;
    const altOldUsers = phoneToOldUsers[phone] || [];

    // Filter out the mapped user, try each alternate
    const candidates = altOldUsers.filter(id => id !== mappedOldUser);
    if (candidates.length === 0) {
      companiesSkippedNoAltUser++;
      continue;
    }

    // Find first candidate with consumption data
    let found = false;
    for (const altUserId of candidates) {
      const { rows: cons } = await oldDb.query(`
        SELECT amount, quantity, date
        FROM verification_ledger
        WHERE user_id = $1 AND transaction_type_id IN (3, 4, 5, 6)
        ORDER BY date ASC
      `, [altUserId]);

      if (cons.length > 0) {
        const result = await fixCompanyPricing(newDb, companyId, cons);
        if (result.updated > 0) {
          info(`  Company ${companyId}: mapped user ${mappedOldUser || 'none'} → alt user ${altUserId} (${cons.length} ledger entries, ${result.updated} items fixed)`);
          totalFixed += result.updated;
          totalInvoicesRecalced += result.invoices;
          companiesFixed++;
          found = true;
          break;
        }
      }
    }

    if (!found) {
      companiesSkippedNoLedger++;
    }

    if ((ci + 1) % 500 === 0) {
      info(`  Checked ${ci + 1}/${zeroCos.length} companies...`);
    }
  }

  flushErrors();
  success(`Done!
  Companies with zero-priced items: ${zeroCos.length}
  Companies fixed: ${companiesFixed}
  Total items fixed: ${totalFixed}
  Total invoices recalculated: ${totalInvoicesRecalced}
  Skipped (no user phone in new DB): ${companiesSkippedNoPhone}
  Skipped (no alternate old user by phone): ${companiesSkippedNoAltUser}
  Skipped (no consumption ledger on any matching user): ${companiesSkippedNoLedger}`);

  await closeOldDb();
  await closeNewDb();
}

async function fixCompanyPricing(newDb, companyId, consumptionRows) {
  // Expand consumption entries into per-unit prices
  const prices = [];
  for (const r of consumptionRows) {
    const qty = Number(r.quantity) || 1;
    const perUnit = qty > 0 ? Math.round((Number(r.amount) / qty) * 100) / 100 : 0;
    for (let i = 0; i < qty; i++) {
      prices.push(perUnit);
    }
  }

  if (prices.length === 0 || prices.every(p => p === 0)) {
    return { updated: 0, invoices: 0 };
  }

  // Load zero-priced items for this company
  const { rows: zeroItems } = await newDb.query(`
    SELECT ii.id AS "itemId", ii."invoiceId", vt."createdAt" AS "taskDate"
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii."invoiceId"
    JOIN verification_tasks vt ON vt.id = ii."taskId"
    WHERE i."companyId" = $1
      AND i."invoiceNumber" LIKE 'MIG-%'
      AND ii."unitPrice" = 0
    ORDER BY vt."createdAt" ASC
  `, [companyId]);

  if (zeroItems.length === 0) return { updated: 0, invoices: 0 };

  let updated = 0;
  const invoicesToRecalc = new Set();

  for (let i = 0; i < zeroItems.length; i++) {
    const item = zeroItems[i];
    let price;
    if (i < prices.length) {
      price = prices[i];
    } else {
      price = prices[prices.length - 1]; // last known price
    }

    if (price > 0) {
      await newDb.query(`UPDATE invoice_items SET "unitPrice" = $1 WHERE id = $2`, [price, item.itemId]);
      invoicesToRecalc.add(item.invoiceId);
      updated++;
    }
  }

  // Recalculate invoice totals
  for (const invoiceId of invoicesToRecalc) {
    await newDb.query(`
      UPDATE invoices SET "totalAmount" = (
        SELECT COALESCE(SUM("unitPrice"), 0) FROM invoice_items WHERE "invoiceId" = $1
      ) WHERE id = $1
    `, [invoiceId]);
  }

  return { updated, invoices: invoicesToRecalc.size };
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
