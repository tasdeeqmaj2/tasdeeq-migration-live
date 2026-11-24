/**
 * Investigate a specific user to find orphan companies and missing workers.
 * Usage: node check-user.js
 */
require('dotenv').config();
const { Client } = require('pg');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!NEW_DB_URL || !OLD_DB_URL) { console.error('Set both NEW_DATABASE_URL and OLD_DATABASE_URL in .env'); process.exit(1); }
const SSL = { rejectUnauthorized: false };

const TARGET_EMAIL = 'umair.shamim@hrbs.com.pk';

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await newDb.connect();
  await oldDb.connect();

  // 1. Find user in new DB
  console.log(`=== Looking up ${TARGET_EMAIL} in NEW DB ===`);
  const { rows: users } = await newDb.query(
    `SELECT id, name, email, role, phone FROM users WHERE LOWER(email) = LOWER($1)`,
    [TARGET_EMAIL]
  );
  console.log(`  Found ${users.length} user(s)`);
  for (const u of users) {
    console.log(`  User: ${u.name} (${u.email}) role=${u.role} id=${u.id}`);

    // Find their companies
    const { rows: companies } = await newDb.query(`
      SELECT cu."companyId", cu.role AS corp_role, c.name, c."isConsumer",
             (SELECT COUNT(*)::int FROM workers w WHERE w."companyId" = cu."companyId") AS workers
      FROM corporate_users cu
      JOIN companies c ON c.id = cu."companyId"
      WHERE cu."userId" = $1
    `, [u.id]);
    for (const c of companies) {
      console.log(`    Company: "${c.name}" id=${c.companyId} isConsumer=${c.isConsumer} workers=${c.workers} role=${c.corp_role}`);
    }
  }

  // 2. Find user in old DB by email
  console.log(`\n=== Looking up in OLD DB ===`);
  const { rows: oldUsers } = await oldDb.query(
    `SELECT id, name, email, phone_number AS phone FROM "user" WHERE LOWER(email) = LOWER($1)`,
    [TARGET_EMAIL]
  );
  if (oldUsers.length === 0) {
    // Old DB emails might be encrypted - try phone match
    console.log('  Not found by email (may be encrypted). Trying other approaches...');

    // Check if any migrated consumer company has this user's email pattern
    if (users.length > 0) {
      const phone = users[0].phone;
      if (phone) {
        const { rows: byPhone } = await oldDb.query(
          `SELECT id, name, email, phone_number AS phone FROM "user" WHERE phone_number = $1 OR phone_number = $2`,
          [phone, phone.replace(/^\+92/, '0')]
        );
        console.log(`  By phone (${phone}): found ${byPhone.length}`);
        for (const u of byPhone) console.log(`    Old user: id=${u.id} name=${u.name} email=${u.email} phone=${u.phone}`);
      }
    }
  } else {
    for (const u of oldUsers) {
      console.log(`  Old user: id=${u.id} name=${u.name} email=${u.email} phone=${u.phone}`);

      // Count their workers in old DB
      const { rows: [{ cnt }] } = await oldDb.query(
        `SELECT COUNT(*)::int AS cnt FROM user_worker_employment WHERE user_id = $1`,
        [u.id]
      );
      console.log(`    Old employments: ${cnt}`);
    }
  }

  // 3. Find any orphan (isConsumer) companies that might belong to this user
  console.log(`\n=== Checking orphan consumer companies with migrated emails ===`);
  // If we found old user IDs, check for migrated-{id}@consumer.tasdeeq.app
  const oldIds = oldUsers.map(u => u.id);
  if (users.length > 0 && users[0].phone) {
    // Also try finding old user by phone
    const phone = users[0].phone;
    const { rows: phoneMatches } = await oldDb.query(
      `SELECT id FROM "user" WHERE phone_number = $1 OR phone_number = $2`,
      [phone, phone.replace(/^\+92/, '0')]
    );
    for (const pm of phoneMatches) {
      if (!oldIds.includes(pm.id)) oldIds.push(pm.id);
    }
  }

  for (const oldId of oldIds) {
    const migratedEmail = `migrated-${oldId}@consumer.tasdeeq.app`;
    const { rows: orphans } = await newDb.query(`
      SELECT c.id, c.name, c."isConsumer",
             (SELECT COUNT(*)::int FROM workers w WHERE w."companyId" = c.id) AS workers
      FROM companies c
      JOIN users u ON u.id = (
        SELECT cu."userId" FROM corporate_users cu WHERE cu."companyId" = c.id LIMIT 1
      )
      WHERE u.email = $1
    `, [migratedEmail]);

    if (orphans.length > 0) {
      console.log(`  Found orphan for old user ${oldId} (${migratedEmail}):`);
      for (const o of orphans) {
        console.log(`    Company: "${o.name}" id=${o.id} isConsumer=${o.isConsumer} workers=${o.workers}`);
      }
    }
  }

  // 4. Broader search: find all isConsumer companies where the name might match
  if (users.length > 0) {
    const { rows: consumerCompanies } = await newDb.query(`
      SELECT c.id, c.name, c."isConsumer",
             (SELECT COUNT(*)::int FROM workers w WHERE w."companyId" = c.id) AS workers,
             u.email AS owner_email
      FROM companies c
      JOIN corporate_users cu ON cu."companyId" = c.id
      JOIN users u ON u.id = cu."userId"
      WHERE c."isConsumer" = true
        AND (SELECT COUNT(*)::int FROM workers w WHERE w."companyId" = c.id) > 0
        AND u.email LIKE 'migrated-%@consumer.tasdeeq.app'
      ORDER BY workers DESC
      LIMIT 50
    `);

    // Check if any of these orphans match by looking up the old user and comparing
    console.log(`\n=== All remaining orphan companies with workers ===`);
    for (const c of consumerCompanies) {
      const match = c.owner_email.match(/^migrated-(\d+)@consumer\.tasdeeq\.app$/);
      if (!match) continue;
      const oId = match[1];

      // Look up this old user's real email/phone
      const { rows: ou } = await oldDb.query(
        `SELECT id, name, email, phone_number AS phone FROM "user" WHERE id = $1`, [oId]
      );
      if (ou.length && ou[0].phone) {
        // Check if phone matches our target user
        const targetPhone = users[0]?.phone;
        const oldPhone = ou[0].phone;
        if (targetPhone && (oldPhone === targetPhone || oldPhone === targetPhone.replace(/^\+92/, '0') || '+92' + oldPhone.slice(1) === targetPhone)) {
          console.log(`  *** MATCH by phone! Orphan: "${c.name}" (${c.id}) ${c.workers} workers`);
          console.log(`      Old user: id=${oId} name=${ou[0].name} phone=${ou[0].phone}`);
        }
      }
    }
  }

  await newDb.end();
  await oldDb.end();
}
run().catch(e => { console.error(e); process.exit(1); });
