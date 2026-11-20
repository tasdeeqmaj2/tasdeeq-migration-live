/**
 * Fix pricing on existing MIG invoices for already-migrated corporate users.
 * Updates invoice_items.unitPrice and invoices.totalAmount using actual
 * per-verification consumption entries from verification_ledger (types 3,4,5,6).
 *
 * Safe to re-run — only updates items with unitPrice = 0.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { section, info, success, warn, flushErrors } = require('./utils/logger');

async function main() {
  section('Fix MIG invoice pricing for existing migrated users');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap('companyMap.json');

  // Build companyId → oldUserId reverse map
  const companyToOldUser = {};
  for (const [oldKey, companyId] of Object.entries(companyMap)) {
    const stripped = String(oldKey).replace(/^hh-/, '');
    const num = Number(stripped);
    if (!isNaN(num)) companyToOldUser[companyId] = num;
  }

  // Find all MIG invoices that have at least one item with unitPrice = 0
  section('Finding MIG invoices with zero-priced items');
  const { rows: zeroInvoices } = await newDb.query(`
    SELECT DISTINCT i.id AS "invoiceId", i."companyId", i."invoiceNumber", i."createdAt"
    FROM invoices i
    JOIN invoice_items ii ON ii."invoiceId" = i.id
    WHERE i."invoiceNumber" LIKE 'MIG-%'
      AND ii."unitPrice" = 0
    ORDER BY i."companyId", i."createdAt"
  `);
  info(`MIG invoices with zero-priced items: ${zeroInvoices.length}`);

  if (zeroInvoices.length === 0) {
    success('Nothing to fix — all MIG invoices already have pricing.');
    return;
  }

  // Get unique companyIds and their old user IDs
  const affectedCompanyIds = [...new Set(zeroInvoices.map(r => r.companyId))];
  const affectedOldUserIds = [];
  const oldUserByCompany = {};
  for (const cid of affectedCompanyIds) {
    const oldUserId = companyToOldUser[cid];
    if (oldUserId) {
      affectedOldUserIds.push(oldUserId);
      oldUserByCompany[cid] = oldUserId;
    }
  }
  info(`Affected companies: ${affectedCompanyIds.length}, with old user mapping: ${affectedOldUserIds.length}`);

  // Load consumption ledger entries for affected users (types 3,4,5,6)
  section('Loading consumption ledger entries from old DB');
  const consumptionByUser = {};
  for (let i = 0; i < affectedOldUserIds.length; i += 5000) {
    const chunk = affectedOldUserIds.slice(i, i + 5000);
    const { rows } = await oldDb.query(`
      SELECT user_id, amount, quantity, date
      FROM verification_ledger
      WHERE user_id = ANY($1::bigint[]) AND transaction_type_id IN (3, 4, 5, 6)
      ORDER BY user_id, date ASC
    `, [chunk]);
    for (const r of rows) {
      const uid = Number(r.user_id);
      if (!consumptionByUser[uid]) consumptionByUser[uid] = [];
      const qty = Number(r.quantity) || 1;
      const perUnit = qty > 0 ? Math.round((Number(r.amount) / qty) * 100) / 100 : 0;
      for (let q = 0; q < qty; q++) {
        consumptionByUser[uid].push({ price: perUnit, date: r.date });
      }
    }
  }
  info(`Users with consumption entries: ${Object.keys(consumptionByUser).length}`);

  // Load all zero-priced items grouped by company, sorted by task creation date
  section('Loading zero-priced invoice items');
  const { rows: zeroItems } = await newDb.query(`
    SELECT ii.id AS "itemId", ii."invoiceId", ii."taskId", ii."unitPrice",
           vt."createdAt" AS "taskCreatedAt", i."companyId"
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii."invoiceId"
    JOIN verification_tasks vt ON vt.id = ii."taskId"
    WHERE i."invoiceNumber" LIKE 'MIG-%'
      AND ii."unitPrice" = 0
    ORDER BY i."companyId", vt."createdAt" ASC
  `);
  info(`Zero-priced invoice items: ${zeroItems.length}`);

  // Group items by company
  const itemsByCompany = {};
  for (const item of zeroItems) {
    if (!itemsByCompany[item.companyId]) itemsByCompany[item.companyId] = [];
    itemsByCompany[item.companyId].push(item);
  }

  // Fix pricing: pair items with consumption entries 1:1 by chronological order
  section('Updating prices');
  let updatedItems = 0;
  let updatedInvoices = 0;
  let skippedNoMapping = 0;
  let skippedNoConsumption = 0;

  const invoicesToRecalc = new Set();

  for (const [companyId, items] of Object.entries(itemsByCompany)) {
    const oldUserId = oldUserByCompany[companyId];
    if (!oldUserId) {
      skippedNoMapping += items.length;
      continue;
    }

    const consumptions = consumptionByUser[oldUserId];
    if (!consumptions || consumptions.length === 0) {
      skippedNoConsumption += items.length;
      continue;
    }

    // Items are already sorted by taskCreatedAt
    // Pair with consumption entries by chronological order
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      let price;
      if (idx < consumptions.length) {
        price = consumptions[idx].price;
      } else {
        // More items than consumption entries — use last known price
        price = consumptions[consumptions.length - 1].price;
      }

      if (price > 0) {
        await newDb.query(`UPDATE invoice_items SET "unitPrice" = $1 WHERE id = $2`, [price, item.itemId]);
        invoicesToRecalc.add(item.invoiceId);
        updatedItems++;
      }
    }
  }

  // Recalculate totalAmount for affected invoices
  section('Recalculating invoice totals');
  for (const invoiceId of invoicesToRecalc) {
    await newDb.query(`
      UPDATE invoices SET "totalAmount" = (
        SELECT COALESCE(SUM("unitPrice"), 0) FROM invoice_items WHERE "invoiceId" = $1
      ) WHERE id = $1
    `, [invoiceId]);
    updatedInvoices++;
  }

  flushErrors();
  success(`Done!
  Zero-priced items found: ${zeroItems.length}
  Items updated with real price: ${updatedItems}
  Invoices recalculated: ${updatedInvoices}
  Skipped (no old user mapping): ${skippedNoMapping}
  Skipped (no consumption data): ${skippedNoConsumption}`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
