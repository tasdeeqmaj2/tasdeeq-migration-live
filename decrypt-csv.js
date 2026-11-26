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
    SELECT u.id, u.name, u.email, u.phone_number AS phone,
           uav.available_verification AS units, uav.free_verification AS free_units
    FROM user_available_verification uav
    JOIN "user" u ON u.id = uav.user_id
    WHERE uav.available_verification > 0
    ORDER BY uav.available_verification DESC
  `);

  console.log('old_user_id,name,email,phone,available_units,free_units');
  for (const r of rows) {
    const email = (decryptIfEncrypted(r.email) || r.email).replace(/,/g, ' ');
    const phone = (decryptIfEncrypted(r.phone) || r.phone).replace(/,/g, ' ');
    const name = (r.name || '').replace(/,/g, ' ').replace(/"/g, '');
    console.log(`${r.id},"${name}","${email}","${phone}",${r.units},${r.free_units}`);
  }

  await oldDb.end();
}

run().catch(e => { console.error(e); process.exit(1); });
