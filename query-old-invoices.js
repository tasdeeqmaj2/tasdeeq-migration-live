require('dotenv').config();
const { Client } = require('pg');
const { decryptIfEncrypted } = require('./utils/decrypt');

async function run() {
  const oldDb = new Client({
    connectionString: process.env.OLD_DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await oldDb.connect();

  const { rows } = await oldDb.query(`
    SELECT
      u.id AS old_user_id,
      u.name,
      u.email,
      u.phone_number AS phone,
      uav.available_verification AS available_units,
      COALESCE(inv.invoice_count, 0) AS invoice_count,
      COALESCE(inv.total_paid, 0) AS total_paid,
      COALESCE(inv.total_workers, 0) AS total_workers
    FROM user_available_verification uav
    JOIN "user" u ON u.id = uav.user_id
    LEFT JOIN (
      SELECT user_id,
             COUNT(*)::int AS invoice_count,
             SUM(amount::numeric)::numeric AS total_paid,
             SUM(worker_count::numeric)::numeric AS total_workers
      FROM worker_purchase_invoice
      WHERE payment_status = 'approved'
      GROUP BY user_id
    ) inv ON inv.user_id = uav.user_id
    WHERE uav.available_verification > 0
    ORDER BY uav.available_verification DESC
  `);

  console.log('old_user_id,name,email,phone,available_units,invoice_count,total_paid,total_workers');
  for (const r of rows) {
    const email = (decryptIfEncrypted(r.email) || r.email).replace(/,/g, ' ');
    const phone = (decryptIfEncrypted(r.phone) || r.phone).replace(/,/g, ' ');
    const name = (r.name || '').replace(/,/g, ' ').replace(/"/g, '');
    console.log(`${r.old_user_id},"${name}","${email}","${phone}",${r.available_units},${r.invoice_count},${r.total_paid},${r.total_workers}`);
  }

  await oldDb.end();
}

run().catch(e => { console.error(e); process.exit(1); });
