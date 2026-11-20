/**
 * Fix users who signed up on the new app (creating an empty consumer company)
 * but whose old workers sit on a separate migrated company.
 *
 * Detects by matching User.phone → old DB → old user ID → companyMap → migrated company.
 * If the user's current company is empty and the migrated company has workers,
 * reassign the user to the migrated company and delete the empty one.
 *
 * Safe to re-run — skips users already on a company with workers.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { resolvePhone } = require('./utils/contactFields');
const { section, info, success, warn, flushErrors } = require('./utils/logger');

async function main() {
  section('Fix duplicate companies — merge empty consumer into migrated company');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap('companyMap.json');

  // Also load unmapped user map
  const unmappedMapPath = path.join(__dirname, 'mappings', 'unmappedUserMap.json');
  let unmappedMap = {};
  if (fs.existsSync(unmappedMapPath)) {
    unmappedMap = JSON.parse(fs.readFileSync(unmappedMapPath, 'utf8'));
  }

  // Build oldUserId → companyId from both maps
  const oldUserToCompany = {};
  for (const [oldKey, companyId] of Object.entries(companyMap)) {
    const stripped = String(oldKey).replace(/^hh-/, '');
    const num = Number(stripped);
    if (!isNaN(num)) oldUserToCompany[num] = companyId;
  }
  for (const [oldUserId, data] of Object.entries(unmappedMap)) {
    const num = Number(oldUserId);
    if (!isNaN(num) && data.companyId) oldUserToCompany[num] = data.companyId;
  }

  // Build phone → oldUserId from old DB
  section('Loading old user phones');
  const { rows: oldUsers } = await oldDb.query(`
    SELECT id, phone_number FROM "user"
    WHERE phone_number IS NOT NULL AND phone_number != ''
  `);

  const phoneToOldUser = {};
  for (const u of oldUsers) {
    const phone = resolvePhone(u.phone_number, { migration: 'fix_dup' });
    if (phone && phone.length >= 10) {
      phoneToOldUser[phone] = Number(u.id);
    }
  }
  info(`Old users with valid phones: ${Object.keys(phoneToOldUser).length}`);

  // Find all consumer users with phone set, on a company with 0 workers
  section('Finding consumer users on empty companies');
  const { rows: emptyConsumers } = await newDb.query(`
    SELECT u.id AS "userId", u.phone, u.name, u.email,
           cu.id AS "cuId", cu."companyId",
           c.name AS "companyName", c."isConsumer"
    FROM users u
    JOIN corporate_users cu ON cu."userId" = u.id
    JOIN companies c ON c.id = cu."companyId"
    WHERE u.phone IS NOT NULL
      AND u.role = 'CONSUMER'
      AND NOT EXISTS (SELECT 1 FROM workers w WHERE w."companyId" = c.id)
  `);
  info(`Consumer users on empty companies: ${emptyConsumers.length}`);

  let fixed = 0;
  let skippedNoOldUser = 0;
  let skippedNoMigratedCompany = 0;
  let skippedMigratedEmpty = 0;
  let skippedSameCompany = 0;
  let failed = 0;

  for (const row of emptyConsumers) {
    const phone = row.phone;
    const oldUserId = phoneToOldUser[phone];

    if (!oldUserId) {
      skippedNoOldUser++;
      continue;
    }

    const migratedCompanyId = oldUserToCompany[oldUserId];
    if (!migratedCompanyId) {
      skippedNoMigratedCompany++;
      continue;
    }

    if (migratedCompanyId === row.companyId) {
      skippedSameCompany++;
      continue;
    }

    // Check migrated company has workers
    const { rows: wc } = await newDb.query(
      `SELECT COUNT(*)::int AS cnt FROM workers WHERE "companyId" = $1`,
      [migratedCompanyId]
    );
    if (wc[0].cnt === 0) {
      skippedMigratedEmpty++;
      continue;
    }

    // Check no other users are on the empty company
    const { rows: otherUsers } = await newDb.query(
      `SELECT COUNT(*)::int AS cnt FROM corporate_users WHERE "companyId" = $1 AND "userId" != $2`,
      [row.companyId, row.userId]
    );

    const client = await newDb.connect();
    try {
      await client.query('BEGIN');

      // 1. Remove any existing link to the migrated company (avoid unique conflicts)
      await client.query(
        `DELETE FROM corporate_users WHERE "companyId" = $1 AND "userId" != $2`,
        [migratedCompanyId, row.userId]
      );

      // 2. Point user to migrated company
      await client.query(
        `UPDATE corporate_users SET "companyId" = $1 WHERE id = $2`,
        [migratedCompanyId, row.cuId]
      );

      // 3. Make migrated company isConsumer = true
      await client.query(
        `UPDATE companies SET "isConsumer" = true WHERE id = $1`,
        [migratedCompanyId]
      );

      // 4. Delete empty company (only if no other users on it)
      if (otherUsers[0].cnt === 0) {
        // Delete any stray data on the empty company
        await client.query(`DELETE FROM invoice_items WHERE "invoiceId" IN (SELECT id FROM invoices WHERE "companyId" = $1)`, [row.companyId]);
        await client.query(`DELETE FROM invoices WHERE "companyId" = $1`, [row.companyId]);
        await client.query(`DELETE FROM verification_tasks WHERE "companyId" = $1`, [row.companyId]);
        await client.query(`DELETE FROM workers WHERE "companyId" = $1`, [row.companyId]);
        await client.query(`DELETE FROM corporate_users WHERE "companyId" = $1`, [row.companyId]);
        await client.query(`DELETE FROM companies WHERE id = $1`, [row.companyId]);
      }

      await client.query('COMMIT');

      info(`  Fixed ${row.name} (${phone}): ${row.companyId} → ${migratedCompanyId} (${wc[0].cnt} workers)`);
      fixed++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      warn(`Failed ${row.userId} (${phone}): ${err.message}`);
      failed++;
    } finally {
      client.release();
    }
  }

  flushErrors();
  success(`Done!
  Empty consumer accounts checked: ${emptyConsumers.length}
  Fixed (reassigned to migrated company): ${fixed}
  Skipped (no old user match by phone): ${skippedNoOldUser}
  Skipped (no migrated company): ${skippedNoMigratedCompany}
  Skipped (migrated company also empty): ${skippedMigratedEmpty}
  Skipped (already on correct company): ${skippedSameCompany}
  Failed: ${failed}`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
