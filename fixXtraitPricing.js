/**
 * Fix zero-priced MIG invoice items for xtrait97@gmail.com (company cmwnhyifyc18620bc14f11488).
 * The company was mapped from old user 70 (no ledger data), but the actual
 * paid verification history is under old user 56137.
 *
 * Uses user 56137's consumption entries (types 3,4,5,6) paired chronologically.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { section, info, success, warn, flushErrors } = require('./utils/logger');

const COMPANY_ID = 'cmwnhyifyc18620bc14f11488';
const OLD_USER_ID = 56137;

async function main() {
  section(`Fix pricing for company ${COMPANY_ID} using old user ${OLD_USER_ID} ledger`);

  const oldDb = getOldDb();
  const newDb = getNewDb();

  // Load consumption entries (types 3,4,5,6) for user 56137
  section('Loading consumption ledger entries');
  const { rows: cons } = await oldDb.query(`
    SELECT amount, quantity, date
    FROM verification_ledger
    WHERE user_id = $1 AND transaction_type_id IN (3, 4, 5, 6)
    ORDER BY date ASC
  `, [OLD_USER_ID]);

  // Expand into per-unit prices
  const prices = [];
  for (const r of cons) {
    const qty = Number(r.quantity) || 1;
    const perUnit = qty > 0 ? Math.round((Number(r.amount) / qty) * 100) / 100 : 0;
    for (let i = 0; i < qty; i++) {
      prices.push(perUnit);
    }
  }
  info(`Consumption entries: ${cons.length}, expanded to ${prices.length} per-unit prices`);
  if (prices.length > 0) {
    const unique = [...new Set(prices)].sort((a, b) => a - b);
    info(`Price values seen: ${unique.join(', ')}`);
  }

  // Load zero-priced items for this company
  section('Loading zero-priced invoice items');
  const { rows: zeroItems } = await newDb.query(`
    SELECT ii.id AS "itemId", ii."invoiceId", vt."createdAt" AS "taskDate"
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii."invoiceId"
    JOIN verification_tasks vt ON vt.id = ii."taskId"
    WHERE i."companyId" = $1
      AND i."invoiceNumber" LIKE 'MIG-%'
      AND ii."unitPrice" = 0
    ORDER BY vt."createdAt" ASC
  `, [COMPANY_ID]);
  info(`Zero-priced items: ${zeroItems.length}`);

  if (zeroItems.length === 0) {
    success('Nothing to fix!');
    await closeOldDb(); await closeNewDb();
    return;
  }

  // Pair chronologically
  section('Updating prices');
  let updated = 0;
  const invoicesToRecalc = new Set();

  for (let i = 0; i < zeroItems.length; i++) {
    const item = zeroItems[i];
    let price;
    if (i < prices.length) {
      price = prices[i];
    } else {
      // Use the last known price for any extras
      price = prices.length > 0 ? prices[prices.length - 1] : 0;
    }

    if (price > 0) {
      await newDb.query(`UPDATE invoice_items SET "unitPrice" = $1 WHERE id = $2`, [price, item.itemId]);
      invoicesToRecalc.add(item.invoiceId);
      updated++;
    }
  }
  info(`Items updated: ${updated}`);

  // Recalculate invoice totals
  section('Recalculating invoice totals');
  for (const invoiceId of invoicesToRecalc) {
    await newDb.query(`
      UPDATE invoices SET "totalAmount" = (
        SELECT COALESCE(SUM("unitPrice"), 0) FROM invoice_items WHERE "invoiceId" = $1
      ) WHERE id = $1
    `, [invoiceId]);
  }
  info(`Invoices recalculated: ${invoicesToRecalc.size}`);

  flushErrors();
  success(`Done!
  Zero-priced items found: ${zeroItems.length}
  Items updated with prices: ${updated}
  Invoices recalculated: ${invoicesToRecalc.size}
  Consumption prices available: ${prices.length}`);

  await closeOldDb();
  await closeNewDb();
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
