process.env.TZ = 'UTC';
require('dotenv').config();
const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const fs = require('fs');
const path = require('path');

async function main() {
  const newDb = getNewDb();
  const oldDb = getOldDb();
  const companyMap = loadMap('companyMap.json');

  // Also load unmapped map
  const unmappedMapPath = path.join(__dirname, 'mappings', 'unmappedUserMap.json');
  let unmappedMap = {};
  if (fs.existsSync(unmappedMapPath)) {
    unmappedMap = JSON.parse(fs.readFileSync(unmappedMapPath, 'utf8'));
  }

  // Find user
  const { rows: u } = await newDb.query(`
    SELECT u.id, u.email, u.phone, cu."companyId"
    FROM users u JOIN corporate_users cu ON cu."userId" = u.id
    WHERE u.email = 'xtrait97@gmail.com'
  `);
  console.log('User:', JSON.stringify(u));
  if (!u.length) { await closeNewDb(); await closeOldDb(); return; }

  const cid = u[0].companyId;

  // Find old user ID from companyMap
  let oldUserId = null;
  for (const [key, val] of Object.entries(companyMap)) {
    if (val === cid) { oldUserId = key; break; }
  }
  // Also check unmapped map
  if (!oldUserId) {
    for (const [key, val] of Object.entries(unmappedMap)) {
      if (val.companyId === cid) { oldUserId = key; break; }
    }
    if (oldUserId) console.log('Found in unmappedMap');
  }
  console.log('Old user key:', oldUserId);

  // Check invoices
  const { rows: inv } = await newDb.query(`
    SELECT i.id, i."invoiceNumber", i."totalAmount"::numeric, i.status,
      (SELECT COUNT(*)::int FROM invoice_items ii WHERE ii."invoiceId" = i.id) AS items,
      (SELECT COUNT(*)::int FROM invoice_items ii WHERE ii."invoiceId" = i.id AND ii."unitPrice" = 0) AS zero_items
    FROM invoices i WHERE i."companyId" = $1 ORDER BY i."createdAt"
  `, [cid]);
  console.log('Invoices:', JSON.stringify(inv, null, 2));

  // Check if this is a MIG invoice or not
  const { rows: allItems } = await newDb.query(`
    SELECT ii.id, ii."unitPrice"::numeric, i."invoiceNumber"
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii."invoiceId"
    WHERE i."companyId" = $1
    ORDER BY i."createdAt", ii.id
    LIMIT 20
  `, [cid]);
  console.log('All items (first 20):', JSON.stringify(allItems, null, 2));

  // Check old DB ledger if we have old user ID
  if (oldUserId) {
    const stripped = String(oldUserId).replace(/^hh-/, '');
    const num = Number(stripped);
    if (!isNaN(num)) {
      const { rows: ledger } = await oldDb.query(`
        SELECT transaction_type_id, amount, quantity, date
        FROM verification_ledger
        WHERE user_id = $1
        ORDER BY date
      `, [num]);
      console.log('Old ledger entries:', ledger.length);
      if (ledger.length > 0) console.log('Ledger:', JSON.stringify(ledger, null, 2));
    }
  }

  await closeNewDb();
  await closeOldDb();
}
main().catch(e => { console.error(e); process.exit(1); });
