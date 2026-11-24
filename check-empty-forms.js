require('dotenv').config();
const { Client } = require('pg');
const DB_URL = process.env.NEW_DATABASE_URL;
if (!DB_URL) { console.error('Set NEW_DATABASE_URL in .env'); process.exit(1); }
const TARGET_IDS = [
  'cmwnhyifyc18620bc14f11488',
  'cmwnhyifz23013d9398666cdc',
  'cmwnhyifz630bac7aae6ced6d',
];
async function run() {
  const db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  for (const companyId of TARGET_IDS) {
    const { rows: [company] } = await db.query(`SELECT name FROM companies WHERE id = $1`, [companyId]);
    console.log(`\n=== ${company?.name ?? companyId} ===`);
    const { rows: [{ total }] } = await db.query(`SELECT COUNT(*)::int AS total FROM verification_tasks WHERE "companyId" = $1`, [companyId]);
    const { rows: [{ with_form }] } = await db.query(`SELECT COUNT(*)::int AS with_form FROM verification_tasks vt JOIN criminal_verification_forms cf ON cf."taskId" = vt.id WHERE vt."companyId" = $1`, [companyId]);
    console.log(`  Total tasks: ${total}, With form: ${with_form}, Without form: ${total - with_form}`);
    const { rows: statusBreakdown } = await db.query(`SELECT vt.status, COUNT(*)::int AS cnt, SUM(CASE WHEN cf."taskId" IS NULL THEN 1 ELSE 0 END)::int AS no_form FROM verification_tasks vt LEFT JOIN criminal_verification_forms cf ON cf."taskId" = vt.id WHERE vt."companyId" = $1 GROUP BY vt.status ORDER BY cnt DESC`, [companyId]);
    console.log('  Status breakdown:');
    for (const r of statusBreakdown) console.log(`    ${r.status.padEnd(20)} ${String(r.cnt).padStart(5)}  no_form: ${r.no_form}`);
  }
  await db.end();
}
run().catch(e => { console.error(e); process.exit(1); });
