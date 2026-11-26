require('dotenv').config();
const { Client } = require('pg');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
const NEW_DB_URL = process.env.NEW_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';

async function run() {
  const db = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  await db.connect();

  console.log(`MODE: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // Find existing max INV- number per month
  const { rows: existingMaxes } = await db.query(`
    SELECT SUBSTRING("invoiceNumber" FROM 5 FOR 6) AS month,
           MAX(CAST(SUBSTRING("invoiceNumber" FROM 12) AS int)) AS max_num
    FROM invoices
    WHERE "invoiceNumber" ~ '^INV-\\d{6}-\\d+'
    GROUP BY 1
  `);

  const monthCounters = {};
  for (const r of existingMaxes) {
    monthCounters[r.month] = r.max_num;
  }
  console.log('Existing month max:', JSON.stringify(monthCounters));

  // Get all MIG- invoices (excluding MIG-BAL which are balance records)
  const { rows: toRename } = await db.query(`
    SELECT id, "invoiceNumber", "createdAt"
    FROM invoices
    WHERE "invoiceNumber" LIKE 'MIG-%'
      AND "invoiceNumber" NOT LIKE 'MIG-BAL-%'
    ORDER BY "createdAt" ASC
  `);

  console.log(`Invoices to rename: ${toRename.length}`);
  if (!toRename.length) { await db.end(); return; }

  const renames = [];
  for (const inv of toRename) {
    const d = new Date(inv.createdAt);
    const ym = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0');
    monthCounters[ym] = (monthCounters[ym] || 0) + 1;
    const newNum = `INV-${ym}-${String(monthCounters[ym]).padStart(4, '0')}`;
    renames.push({ id: inv.id, oldNum: inv.invoiceNumber, newNum });
  }

  console.log('Sample:', renames.slice(0, 3).map(r => r.newNum));
  console.log('Last:', renames.slice(-3).map(r => r.newNum));

  if (!DRY_RUN) {
    await db.query('BEGIN');
    let count = 0;
    for (const r of renames) {
      await db.query(`UPDATE invoices SET "invoiceNumber" = $1 WHERE id = $2`, [r.newNum, r.id]);
      count++;
      if (count % 10000 === 0) console.log(`  Renamed: ${count}`);
    }
    await db.query('COMMIT');
    console.log(`Done! Renamed ${count} invoices`);
  } else {
    console.log(`[DRY] Would rename ${renames.length} invoices`);
  }

  await db.end();
}

run().catch(e => { console.error(e); process.exit(1); });
