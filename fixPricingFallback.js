/**
 * Fix remaining zero-priced MIG invoice items using fallback strategies:
 * 1. Users with only type-1 (purchase) entries — derive unit price from amount/quantity
 * 2. Unmapped users (from migrateUnmappedUsers) — use their consumption entries too
 *
 * Runs after fixMigInvoicePricing.js for items it couldn't fix.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { section, info, success, warn, flushErrors } = require('./utils/logger');

async function main() {
  section('Fix remaining zero-priced MIG invoice items (fallback)');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap('companyMap.json');

  // Load unmapped user map
  const unmappedMapPath = path.join(__dirname, 'mappings', 'unmappedUserMap.json');
  let unmappedMap = {};
  if (fs.existsSync(unmappedMapPath)) {
    unmappedMap = JSON.parse(fs.readFileSync(unmappedMapPath, 'utf8'));
  }

  // Build companyId → oldUserId from BOTH maps
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
  info(`Total company → old user mappings: ${Object.keys(companyToOldUser).length}`);

  // Find all remaining zero-priced items
  section('Loading remaining zero-priced items');
  const { rows: zeroItems } = await newDb.query(`
    SELECT ii.id AS "itemId", ii."invoiceId", ii."taskId",
           vt."createdAt" AS "taskCreatedAt", i."companyId"
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii."invoiceId"
    JOIN verification_tasks vt ON vt.id = ii."taskId"
    WHERE i."invoiceNumber" LIKE 'MIG-%'
      AND ii."unitPrice" = 0
    ORDER BY i."companyId", vt."createdAt" ASC
  `);
  info(`Remaining zero-priced items: ${zeroItems.length}`);

  if (zeroItems.length === 0) {
    success('Nothing to fix.');
    return;
  }

  // Group by company
  const itemsByCompany = {};
  for (const item of zeroItems) {
    if (!itemsByCompany[item.companyId]) itemsByCompany[item.companyId] = [];
    itemsByCompany[item.companyId].push(item);
  }
  info(`Companies with zero-priced items: ${Object.keys(itemsByCompany).length}`);

  // Collect old user IDs we need
  const oldUserIds = new Set();
  for (const companyId of Object.keys(itemsByCompany)) {
    const oldUserId = companyToOldUser[companyId];
    if (oldUserId) oldUserIds.add(oldUserId);
  }
  const oldUserIdArr = [...oldUserIds];
  info(`Old user IDs to look up: ${oldUserIdArr.length}`);

  // Strategy 1: Load ALL ledger entries (all types) for these users
  section('Loading all ledger entries');
  const allLedgerByUser = {}; // oldUserId → { consumptions: [], purchaseUnitPrice: number }

  for (let i = 0; i < oldUserIdArr.length; i += 5000) {
    const chunk = oldUserIdArr.slice(i, i + 5000);

    // Consumption entries (types 3,4,5,6)
    const { rows: cons } = await oldDb.query(`
      SELECT user_id, amount, quantity, date
      FROM verification_ledger
      WHERE user_id = ANY($1::bigint[]) AND transaction_type_id IN (3, 4, 5, 6)
      ORDER BY user_id, date ASC
    `, [chunk]);

    for (const r of cons) {
      const uid = Number(r.user_id);
      if (!allLedgerByUser[uid]) allLedgerByUser[uid] = { consumptions: [], purchaseUnitPrice: 0 };
      const qty = Number(r.quantity) || 1;
      const perUnit = qty > 0 ? Math.round((Number(r.amount) / qty) * 100) / 100 : 0;
      for (let q = 0; q < qty; q++) {
        allLedgerByUser[uid].consumptions.push({ price: perUnit, date: r.date });
      }
    }

    // Purchase entries (type 1) — derive unit price as fallback
    const { rows: purch } = await oldDb.query(`
      SELECT user_id, SUM(amount) AS total_amount, SUM(quantity) AS total_qty
      FROM verification_ledger
      WHERE user_id = ANY($1::bigint[]) AND transaction_type_id = 1
      GROUP BY user_id
    `, [chunk]);

    for (const r of purch) {
      const uid = Number(r.user_id);
      if (!allLedgerByUser[uid]) allLedgerByUser[uid] = { consumptions: [], purchaseUnitPrice: 0 };
      const totalQty = Number(r.total_qty) || 0;
      const totalAmt = Number(r.total_amount) || 0;
      if (totalQty > 0) {
        allLedgerByUser[uid].purchaseUnitPrice = Math.round((totalAmt / totalQty) * 100) / 100;
      }
    }
  }
  info(`Users with any ledger data: ${Object.keys(allLedgerByUser).length}`);

  // Update prices
  section('Updating prices');
  let updatedFromConsumption = 0;
  let updatedFromPurchase = 0;
  let skippedNoMapping = 0;
  let skippedNoData = 0;
  const invoicesToRecalc = new Set();

  for (const [companyId, items] of Object.entries(itemsByCompany)) {
    const oldUserId = companyToOldUser[companyId];
    if (!oldUserId) {
      skippedNoMapping += items.length;
      continue;
    }

    const ledger = allLedgerByUser[oldUserId];
    if (!ledger) {
      skippedNoData += items.length;
      continue;
    }

    const { consumptions, purchaseUnitPrice } = ledger;

    if (consumptions.length > 0) {
      // Strategy 1: pair with consumption entries chronologically
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        let price;
        if (idx < consumptions.length) {
          price = consumptions[idx].price;
        } else {
          price = consumptions[consumptions.length - 1].price;
        }
        if (price > 0) {
          await newDb.query(`UPDATE invoice_items SET "unitPrice" = $1 WHERE id = $2`, [price, item.itemId]);
          invoicesToRecalc.add(item.invoiceId);
          updatedFromConsumption++;
        }
      }
    } else if (purchaseUnitPrice > 0) {
      // Strategy 2: use derived unit price from purchases
      for (const item of items) {
        await newDb.query(`UPDATE invoice_items SET "unitPrice" = $1 WHERE id = $2`, [purchaseUnitPrice, item.itemId]);
        invoicesToRecalc.add(item.invoiceId);
        updatedFromPurchase++;
      }
    } else {
      skippedNoData += items.length;
    }
  }

  // Recalculate invoice totals
  section('Recalculating invoice totals');
  for (const invoiceId of invoicesToRecalc) {
    await newDb.query(`
      UPDATE invoices SET "totalAmount" = (
        SELECT COALESCE(SUM("unitPrice"), 0) FROM invoice_items WHERE "invoiceId" = $1
      ) WHERE id = $1
    `, [invoiceId]);
  }

  flushErrors();
  success(`Done!
  Remaining zero-priced items: ${zeroItems.length}
  Fixed from consumption entries: ${updatedFromConsumption}
  Fixed from purchase unit price (fallback): ${updatedFromPurchase}
  Invoices recalculated: ${invoicesToRecalc.size}
  Skipped (no company mapping): ${skippedNoMapping}
  Skipped (no ledger data at all): ${skippedNoData}`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
