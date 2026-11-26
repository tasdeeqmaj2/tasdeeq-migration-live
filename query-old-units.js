require('dotenv').config();
const { Client } = require('pg');
const { decryptIfEncrypted } = require('./utils/decrypt');

async function run() {
  const db = new Client({
    connectionString: process.env.OLD_DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await db.connect();

  const { rows } = await db.query(`
    SELECT u.id, u.name, u.email, u.phone_number AS phone,
           uav.available_verification AS units, uav.free_verification AS free_units
    FROM user_available_verification uav
    JOIN "user" u ON u.id = uav.user_id
    WHERE uav.available_verification > 0
    ORDER BY uav.available_verification DESC
  `);

  console.log('old_user_id | name | email | phone | available_units | free_units');
  console.log('-'.repeat(120));
  for (const r of rows) {
    const email = decryptIfEncrypted(r.email) || r.email;
    const phone = decryptIfEncrypted(r.phone) || r.phone;
    console.log(`${r.id} | ${r.name} | ${email} | ${phone} | ${r.units} | ${r.free_units}`);
  }
  console.log(`\nTotal: ${rows.length} users with available units`);
  await db.end();
}

run().catch(e => { console.error(e); process.exit(1); });
