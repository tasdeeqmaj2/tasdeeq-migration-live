const { Client } = require('pg');
const { decryptIfEncrypted, looksEncrypted } = require('./utils/decrypt');
const fs = require('fs');
require('dotenv').config();

const OLD_DB_URL = process.env.OLD_DATABASE_URL;
const NEW_DB_URL = process.env.NEW_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
const TARGET_PHONE = '03215244036';

async function run() {
  const oldDb = new Client({ connectionString: OLD_DB_URL });
  const newDb = new Client({ connectionString: NEW_DB_URL });
  await oldDb.connect();
  await newDb.connect();

  console.log('=== OLD DB: Plaintext phone match ===');
  const { rows: plainMatches } = await oldDb.query(
    `SELECT id, email, phone_number, name FROM "user" WHERE phone_number IN ($1, $2, $3)`,
    [TARGET_PHONE, '+92' + TARGET_PHONE, '+923215244036']
  );
  for (const u of plainMatches) {
    const decEmail = decryptIfEncrypted(u.email);
    console.log(`  User ${u.id}: email=${u.email} -> ${decEmail}, phone=${u.phone_number}, name=${u.name}`);
  }
  console.log(`  Found: ${plainMatches.length}\n`);

  console.log('=== OLD DB: Encrypted phone scan ===');
  const { rows: allUsers } = await oldDb.query(
    `SELECT id, email, phone_number, name FROM "user" WHERE phone_number IS NOT NULL AND phone_number != ''`
  );
  const encMatches = [];
  for (const u of allUsers) {
    if (!looksEncrypted(u.phone_number)) continue;
    const decPhone = decryptIfEncrypted(u.phone_number);
    const norm = decPhone.replace(/[\s\-]/g, '');
    if (norm === TARGET_PHONE || norm === '+923215244036' || norm === '923215244036') {
      const decEmail = decryptIfEncrypted(u.email);
      encMatches.push({ ...u, decryptedPhone: decPhone, decryptedEmail: decEmail });
      console.log(`  User ${u.id}: email=${u.email} -> ${decEmail}, encPhone=${u.phone_number} -> ${decPhone}, name=${u.name}`);
    }
  }
  console.log(`  Found: ${encMatches.length}\n`);

  const allFoundIds = [...plainMatches.map(u => u.id), ...encMatches.map(u => u.id)];
  console.log(`All old user IDs for this phone: ${allFoundIds.join(', ')}\n`);

  console.log('=== OLD DB: Workers per user ===');
  for (const uid of allFoundIds) {
    const { rows: workers } = await oldDb.query(
      `SELECT e.id, e.worker_id, e.full_name, e.is_active, w.cnic, w.phone_number
       FROM user_worker_employment e JOIN worker w ON w.id = e.worker_id
       WHERE e.user_id = $1 ORDER BY e.id`, [uid]
    );
    console.log(`\n  User ${uid}: ${workers.length} employments`);
    for (const w of workers) {
      console.log(`    emp=${w.id} worker=${w.worker_id} name="${w.full_name}" cnic=${w.cnic} active=${w.is_active}`);
    }
  }

  console.log('\n=== NEW DB: Find user by phone ===');
  const { rows: newUsers } = await newDb.query(
    `SELECT u.id, u.email, u.phone FROM users u WHERE u.phone IN ($1, $2, $3)`,
    [TARGET_PHONE, '+923215244036', '923215244036']
  );
  console.log(`  Found ${newUsers.length} users`);
  for (const nu of newUsers) {
    console.log(`  userId=${nu.id} email=${nu.email} phone=${nu.phone}`);
    const { rows: companies } = await newDb.query(
      `SELECT cu."companyId", c.name, c."isConsumer" FROM corporate_users cu JOIN companies c ON c.id = cu."companyId" WHERE cu."userId" = $1`, [nu.id]
    );
    for (const co of companies) {
      console.log(`    Company: ${co.companyId} name="${co.name}" isConsumer=${co.isConsumer}`);
      const { rows: workers } = await newDb.query(
        `SELECT w.id, w.name, w.cnic, w.mobile FROM workers w WHERE w."companyId" = $1 ORDER BY w.name`, [co.companyId]
      );
      console.log(`    Workers (${workers.length}):`);
      for (const w of workers) {
        console.log(`      name="${w.name}" cnic=${w.cnic}`);
      }
    }
  }

  console.log('\n=== NEW DB: Find by email hkz1961@gmail.com ===');
  const { rows: byEmail } = await newDb.query(
    `SELECT u.id, u.email, u.phone FROM users u WHERE LOWER(u.email) = 'hkz1961@gmail.com'`
  );
  for (const nu of byEmail) {
    console.log(`  userId=${nu.id} email=${nu.email} phone=${nu.phone}`);
    const { rows: companies } = await newDb.query(
      `SELECT cu."companyId", c.name FROM corporate_users cu JOIN companies c ON c.id = cu."companyId" WHERE cu."userId" = $1`, [nu.id]
    );
    for (const co of companies) {
      console.log(`    Company: ${co.companyId} name="${co.name}"`);
      const { rows: workers } = await newDb.query(
        `SELECT w.id, w.name, w.cnic FROM workers w WHERE w."companyId" = $1 ORDER BY w.name`, [co.companyId]
      );
      console.log(`    Workers (${workers.length}):`);
      for (const w of workers) console.log(`      name="${w.name}" cnic=${w.cnic}`);
    }
  }

  console.log('\n=== Map check ===');
  let workerMap = {}, encWorkerMap = {};
  try { workerMap = JSON.parse(fs.readFileSync('./mappings/workerMap.json', 'utf8')); } catch {}
  try { encWorkerMap = JSON.parse(fs.readFileSync('./mappings/encryptedWorkerMap.json', 'utf8')); } catch {}
  for (const uid of allFoundIds) {
    const { rows: emps } = await oldDb.query(`SELECT id FROM user_worker_employment WHERE user_id = $1`, [uid]);
    for (const e of emps) {
      const eid = String(e.id);
      const inWM = workerMap[eid] ? `workerMap->${workerMap[eid]}` : '';
      const inEM = encWorkerMap[eid] ? `encWorkerMap->${encWorkerMap[eid]}` : '';
      if (inWM || inEM) console.log(`  emp ${eid}: ${inWM} ${inEM}`);
      else console.log(`  emp ${eid}: NOT IN ANY MAP`);
    }
  }

  await oldDb.end();
  await newDb.end();
}
run().catch(e => { console.error(e); process.exit(1); });
