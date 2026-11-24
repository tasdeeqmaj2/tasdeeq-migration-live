require('dotenv').config();
const { Client } = require('pg');
const NEW_DB_URL = process.env.NEW_DATABASE_URL;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
if (!NEW_DB_URL || !OLD_DB_URL) { console.error('Set both DB URLs'); process.exit(1); }
const SSL = { rejectUnauthorized: false };

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await newDb.connect();
  await oldDb.connect();

  const companyId = 'cmwnhyihg639a0e91da02f2c7'; // HR Business Solutions

  // 1. Find all users of this company
  console.log('=== HR Business Solutions — all users ===');
  const { rows: companyUsers } = await newDb.query(`
    SELECT cu.role, u.id, u.name, u.email, u.phone
    FROM corporate_users cu
    JOIN users u ON u.id = cu."userId"
    WHERE cu."companyId" = $1
    ORDER BY cu.role
  `, [companyId]);
  for (const u of companyUsers) {
    console.log(`  ${u.role.padEnd(10)} ${u.name} (${u.email}) phone=${u.phone} id=${u.id}`);
  }

  // 2. For the owner, find their old DB account
  const owner = companyUsers.find(u => u.role === 'OWNER');
  if (owner) {
    console.log(`\n=== Looking up owner in OLD DB ===`);
    // Try by phone
    const phones = [owner.phone, owner.phone?.replace(/^\+92/, '0')].filter(Boolean);
    for (const ph of phones) {
      const { rows } = await oldDb.query(
        `SELECT id, name, email, phone_number AS phone FROM "user" WHERE phone_number = $1`, [ph]
      );
      for (const u of rows) {
        console.log(`  Old user: id=${u.id} name=${u.name} phone=${u.phone}`);

        const { rows: [{ cnt }] } = await oldDb.query(
          `SELECT COUNT(*)::int AS cnt FROM user_worker_employment WHERE user_id = $1`, [u.id]
        );
        console.log(`    Old employments: ${cnt}`);

        // Check for orphan company
        const migratedEmail = `migrated-${u.id}@consumer.tasdeeq.app`;
        const { rows: orphans } = await newDb.query(`
          SELECT c.id, c.name, c."isConsumer",
                 (SELECT COUNT(*)::int FROM workers w WHERE w."companyId" = c.id) AS workers
          FROM companies c
          JOIN corporate_users cu ON cu."companyId" = c.id
          JOIN users u ON u.id = cu."userId"
          WHERE u.email = $1
        `, [migratedEmail]);
        if (orphans.length) {
          console.log(`    *** ORPHAN FOUND: "${orphans[0].name}" id=${orphans[0].id} workers=${orphans[0].workers}`);
        } else {
          console.log(`    No orphan for migrated email ${migratedEmail}`);
        }
      }
    }

    // Also try by email
    const { rows: byEmail } = await oldDb.query(
      `SELECT id, name, email, phone_number AS phone FROM "user" WHERE email = $1`, [owner.email]
    );
    for (const u of byEmail) {
      console.log(`  Old user (by email): id=${u.id} name=${u.name} phone=${u.phone}`);
    }
  }

  // 3. Check all orphan consumer companies for any that might be HRBS
  console.log('\n=== Searching orphans by company name pattern ===');
  const { rows: nameOrphans } = await newDb.query(`
    SELECT c.id, c.name, c."isConsumer",
           (SELECT COUNT(*)::int FROM workers w WHERE w."companyId" = c.id) AS workers,
           u.email AS owner_email
    FROM companies c
    JOIN corporate_users cu ON cu."companyId" = c.id
    JOIN users u ON u.id = cu."userId"
    WHERE c."isConsumer" = true
      AND (LOWER(c.name) LIKE '%hr%' OR LOWER(c.name) LIKE '%business%' OR LOWER(c.name) LIKE '%hrbs%' OR LOWER(c.name) LIKE '%shamim%')
  `);
  for (const o of nameOrphans) {
    console.log(`  "${o.name}" id=${o.id} workers=${o.workers} email=${o.owner_email}`);
  }

  await newDb.end();
  await oldDb.end();
}
run().catch(e => { console.error(e); process.exit(1); });
