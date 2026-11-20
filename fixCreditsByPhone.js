/**
 * Fix Company.creditLimit for companies where the mapped old user has no ledger data
 * but a different old user (same phone) does.
 *
 * Balance = Purchased (type 1) + Bonus (type 2) - Consumed (types 3,4,5,6) in PKR.
 * Only sets creditLimit where currently NULL and balance > 0.
 *
 * Also retries the mapped old user first (catches any stragglers from migrateCredits.js).
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
  section('Fix Company.creditLimit by matching phones to ledger data');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap('companyMap.json');

  // Load unmapped user map
  const unmappedMapPath = path.join(__dirname, 'mappings', 'unmappedUserMap.json');
  let unmappedMap = {};
  if (fs.existsSync(unmappedMapPath)) {
    unmappedMap = JSON.parse(fs.readFileSync(unmappedMapPath, 'utf8'));
  }

  // Build companyId → oldUserId from both maps
  const companyToOldUser = {};
  for (const [oldKey, companyId] of Object.entries(companyMap)) {
    const stripped = String(oldKey).replace(/^hh-/, '');
    const num = Number(stripped);
    if (!isNaN(num)) companyToOldUser[companyId] = num;
  }
  for (const [oldUserId, data] of Object.entries(unmappedMap)) {
    const num = Number(oldUserId);
    if (!isNaN(num) && data.companyId) companyToOldUser[data.companyId] = num;
  }

  // Find all companies with creditLimit IS NULL
  section('Finding companies with NULL creditLimit');
  const { rows: nullCos } = await newDb.query(`
    SELECT c.id AS "companyId"
    FROM companies c
    WHERE c."creditLimit" IS NULL
  `);
  info(`Companies with NULL creditLimit: ${nullCos.length}`);

  // Load ALL old user phones
  section('Loading old user phones');
  const { rows: oldUsers } = await oldDb.query(`
    SELECT id, phone_number FROM "user"
    WHERE phone_number IS NOT NULL AND phone_number != ''
  `);

  const phoneToOldUsers = {};
  const oldUserToPhone = {};
  for (const u of oldUsers) {
    const phone = resolvePhone(u.phone_number, { migration: 'fix_credits_phone' });
    if (phone && phone.length >= 10) {
      if (!phoneToOldUsers[phone]) phoneToOldUsers[phone] = [];
      phoneToOldUsers[phone].push(Number(u.id));
      oldUserToPhone[Number(u.id)] = phone;
    }
  }
  info(`Old users with phones: ${Object.keys(oldUserToPhone).length}`);

  // Process each company
  section('Calculating and updating credit balances');
  let updated = 0;
  let skippedZeroBalance = 0;
  let skippedNoPhone = 0;
  let skippedNoAltUser = 0;
  let skippedNoLedger = 0;

  for (let ci = 0; ci < nullCos.length; ci++) {
    const { companyId } = nullCos[ci];
    const mappedOldUser = companyToOldUser[companyId];

    // First try: mapped old user
    if (mappedOldUser) {
      const balance = await calcBalance(oldDb, mappedOldUser);
      if (balance > 0) {
        await newDb.query(`UPDATE companies SET "creditLimit" = $1 WHERE id = $2 AND "creditLimit" IS NULL`, [balance, companyId]);
        updated++;
        if (updated % 100 === 0) info(`  Updated: ${updated}`);
        continue;
      } else if (balance === 0) {
        // Mapped user has ledger but zero balance — still check alt users
      }
      // balance <= 0 or no data: try phone match
    }

    // Second try: find user phone from new DB, look up alternate old users
    const { rows: companyUsers } = await newDb.query(`
      SELECT u.phone FROM users u
      JOIN corporate_users cu ON cu."userId" = u.id
      WHERE cu."companyId" = $1 AND u.phone IS NOT NULL
      LIMIT 1
    `, [companyId]);

    if (!companyUsers.length || !companyUsers[0].phone) {
      skippedNoPhone++;
      continue;
    }

    const phone = companyUsers[0].phone;
    const altOldUsers = phoneToOldUsers[phone] || [];
    const candidates = altOldUsers.filter(id => id !== mappedOldUser);

    if (candidates.length === 0) {
      skippedNoAltUser++;
      continue;
    }

    // Try each candidate — pick highest positive balance
    let bestBalance = 0;
    let bestUser = null;
    for (const altUserId of candidates) {
      const balance = await calcBalance(oldDb, altUserId);
      if (balance > bestBalance) {
        bestBalance = balance;
        bestUser = altUserId;
      }
    }

    if (bestBalance > 0) {
      await newDb.query(`UPDATE companies SET "creditLimit" = $1 WHERE id = $2 AND "creditLimit" IS NULL`, [bestBalance, companyId]);
      info(`  Company ${companyId}: mapped user ${mappedOldUser || 'none'} → alt user ${bestUser} (balance ${bestBalance} PKR)`);
      updated++;
    } else {
      skippedNoLedger++;
    }

    if ((ci + 1) % 2000 === 0) {
      info(`  Checked ${ci + 1}/${nullCos.length} companies...`);
    }
  }

  flushErrors();
  success(`Done!
  Companies with NULL creditLimit: ${nullCos.length}
  Companies updated with credit balance: ${updated}
  Skipped (no user phone in new DB): ${skippedNoPhone}
  Skipped (no alternate old user by phone): ${skippedNoAltUser}
  Skipped (no ledger data on any matching user): ${skippedNoLedger}`);

  await closeOldDb();
  await closeNewDb();
}

async function calcBalance(oldDb, oldUserId) {
  const { rows: [p] } = await oldDb.query(`
    SELECT COALESCE(SUM(amount), 0)::numeric AS total
    FROM verification_ledger
    WHERE user_id = $1 AND transaction_type_id IN (1, 2)
  `, [oldUserId]);

  const { rows: [c] } = await oldDb.query(`
    SELECT COALESCE(SUM(amount), 0)::numeric AS total
    FROM verification_ledger
    WHERE user_id = $1 AND transaction_type_id IN (3, 4, 5, 6)
  `, [oldUserId]);

  const purchased = Number(p.total) || 0;
  const consumed = Number(c.total) || 0;
  return purchased - consumed;
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
