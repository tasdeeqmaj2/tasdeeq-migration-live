/**
 * Diagnostic: check old DB structure for criminal verification form data.
 * Usage: node check-old-forms.js
 */
require('dotenv').config();
const { Client } = require('pg');
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!OLD_DB_URL) { console.error('Set OLD_DATABASE_URL in .env'); process.exit(1); }

async function run() {
  const db = new Client({ connectionString: OLD_DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // List all tables
  const { rows: tables } = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  console.log('=== ALL TABLES ===');
  console.log(tables.map(t => t.table_name).join('\n'));

  // Look for verification/criminal/form related tables
  const formTables = tables.filter(t =>
    /verif|criminal|form|check|worker|cnic/i.test(t.table_name)
  );
  console.log('\n=== LIKELY FORM TABLES ===');
  for (const t of formTables) {
    const { rows: cols } = await db.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = $1
      ORDER BY ordinal_position
    `, [t.table_name]);
    console.log(`\n--- ${t.table_name} ---`);
    for (const c of cols) console.log(`  ${c.column_name} (${c.data_type})`);
  }

  // Also check the "user" table for a sample migrated user (Osama - old id 56137)
  const { rows: sampleUser } = await db.query(
    `SELECT id, name, email FROM "user" WHERE id = 56137`
  );
  if (sampleUser.length) {
    console.log('\n=== SAMPLE USER (Osama, id=56137) ===');
    console.log(sampleUser[0]);

    // Check if there's a verification request or worker table linked to this user
    for (const t of formTables) {
      const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t.table_name]);
      const colNames = cols.rows.map(c => c.column_name);
      const userCol = colNames.find(c => /user_id|userId|requested_by|company_id/i.test(c));
      if (userCol) {
        const { rows: [count] } = await db.query(
          `SELECT COUNT(*)::int AS cnt FROM "${t.table_name}" WHERE "${userCol}" = $1`, [56137]
        );
        if (count.cnt > 0) console.log(`  ${t.table_name}.${userCol} → ${count.cnt} rows`);
      }
    }
  }

  await db.end();
}
run().catch(e => { console.error(e); process.exit(1); });
