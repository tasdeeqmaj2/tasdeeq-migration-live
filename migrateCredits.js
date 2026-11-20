/**
 * Convert old users' remaining prepaid units into Company.creditLimit in the new system.
 * Uses historical PKR amounts from verification_ledger:
 *   Purchased (type 1) - Consumed (types 3,4,5,6) = Remaining PKR balance
 *
 * This preserves historical rates — a user who bought units at PKR 100
 * gets credit at PKR 100, not the current PKR 500 rate.
 *
 * Safe to re-run — only sets creditLimit where it's currently NULL and balance > 0.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { section, info, success, warn, flushErrors } = require('./utils/logger');
const fs = require('fs');
const path = require('path');

async function main() {
  section('Migrate old unit balances → Company.creditLimit');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap('companyMap.json');

  // Also load unmapped user map if it exists
  const unmappedMapPath = path.join(__dirname, 'mappings', 'unmappedUserMap.json');
  let unmappedMap = {};
  if (fs.existsSync(unmappedMapPath)) {
    unmappedMap = JSON.parse(fs.readFileSync(unmappedMapPath, 'utf8'));
    info(`Unmapped user map loaded: ${Object.keys(unmappedMap).length} entries`);
  }

  // Build oldUserId → companyId from both maps
  const oldUserToCompany = {};

  // From companyMap
  for (const [oldKey, companyId] of Object.entries(companyMap)) {
    const stripped = String(oldKey).replace(/^hh-/, '');
    const num = Number(stripped);
    if (!isNaN(num)) oldUserToCompany[num] = companyId;
  }

  // From unmappedMap
  for (const [oldUserId, data] of Object.entries(unmappedMap)) {
    const num = Number(oldUserId);
    if (!isNaN(num) && data.companyId) oldUserToCompany[num] = data.companyId;
  }

  info(`Total old users with company mapping: ${Object.keys(oldUserToCompany).length}`);

  // Get all old user IDs
  const allOldUserIds = Object.keys(oldUserToCompany).map(Number);

  // Calculate balance per user from verification_ledger
  section('Calculating balances from verification_ledger');

  // Purchased (type 1) — credits added
  const purchased = {};
  for (let i = 0; i < allOldUserIds.length; i += 5000) {
    const chunk = allOldUserIds.slice(i, i + 5000);
    const { rows } = await oldDb.query(`
      SELECT user_id, SUM(amount) AS total_purchased
      FROM verification_ledger
      WHERE user_id = ANY($1::bigint[]) AND transaction_type_id = 1
      GROUP BY user_id
    `, [chunk]);
    for (const r of rows) {
      purchased[Number(r.user_id)] = Number(r.total_purchased) || 0;
    }
  }
  info(`Users with purchases: ${Object.keys(purchased).length}`);

  // Consumed (types 3,4,5,6) — credits used
  const consumed = {};
  for (let i = 0; i < allOldUserIds.length; i += 5000) {
    const chunk = allOldUserIds.slice(i, i + 5000);
    const { rows } = await oldDb.query(`
      SELECT user_id, SUM(amount) AS total_consumed
      FROM verification_ledger
      WHERE user_id = ANY($1::bigint[]) AND transaction_type_id IN (3, 4, 5, 6)
      GROUP BY user_id
    `, [chunk]);
    for (const r of rows) {
      consumed[Number(r.user_id)] = Number(r.total_consumed) || 0;
    }
  }
  info(`Users with consumption: ${Object.keys(consumed).length}`);

  // Also include type 2 (free/bonus credits) as purchased
  const bonus = {};
  for (let i = 0; i < allOldUserIds.length; i += 5000) {
    const chunk = allOldUserIds.slice(i, i + 5000);
    const { rows } = await oldDb.query(`
      SELECT user_id, SUM(amount) AS total_bonus
      FROM verification_ledger
      WHERE user_id = ANY($1::bigint[]) AND transaction_type_id = 2
      GROUP BY user_id
    `, [chunk]);
    for (const r of rows) {
      bonus[Number(r.user_id)] = Number(r.total_bonus) || 0;
    }
  }

  // Calculate remaining balance per user
  const balances = {};
  let positiveCount = 0;
  let zeroCount = 0;
  let negativeCount = 0;

  for (const oldUserId of allOldUserIds) {
    const p = (purchased[oldUserId] || 0) + (bonus[oldUserId] || 0);
    const c = consumed[oldUserId] || 0;
    const remaining = p - c;

    if (remaining > 0) {
      balances[oldUserId] = remaining;
      positiveCount++;
    } else if (remaining < 0) {
      negativeCount++;
    } else {
      zeroCount++;
    }
  }

  info(`Users with positive balance: ${positiveCount}`);
  info(`Users with zero balance: ${zeroCount}`);
  info(`Users with negative balance (over-consumed): ${negativeCount}`);

  // Update Company.creditLimit for users with positive balance
  // Only where creditLimit is currently NULL (don't overwrite manually set values)
  section('Updating Company.creditLimit');
  let updated = 0;
  let skippedAlreadySet = 0;
  let skippedNoCompany = 0;

  for (const [oldUserIdStr, remaining] of Object.entries(balances)) {
    const oldUserId = Number(oldUserIdStr);
    const companyId = oldUserToCompany[oldUserId];
    if (!companyId) {
      skippedNoCompany++;
      continue;
    }

    const { rowCount } = await newDb.query(`
      UPDATE companies SET "creditLimit" = $1 WHERE id = $2 AND "creditLimit" IS NULL
    `, [remaining, companyId]);

    if (rowCount > 0) {
      updated++;
    } else {
      skippedAlreadySet++;
    }

    if ((updated + skippedAlreadySet) % 1000 === 0) {
      info(`  Progress: ${updated + skippedAlreadySet + skippedNoCompany}/${Object.keys(balances).length} — updated: ${updated}`);
    }
  }

  flushErrors();
  success(`Done!
  Total users with positive balance: ${positiveCount}
  Company creditLimit updated: ${updated}
  Skipped (creditLimit already set): ${skippedAlreadySet}
  Skipped (no company mapping): ${skippedNoCompany}

  Examples of what this means:
  - User bought 10 units at PKR 100 (1000 PKR), used 7 (700 PKR) → creditLimit = 300
  - User bought 5 units at PKR 500 (2500 PKR), used 3 (1500 PKR) → creditLimit = 1000
  - Historical rates preserved automatically (ledger stores PKR, not unit counts)`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
