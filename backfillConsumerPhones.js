/**
 * Backfill User.phone for migrated consumer accounts that are missing it.
 * Looks up old user's phone_number via companyMap reverse mapping.
 */
process.env.TZ = 'UTC';
require('dotenv').config();

const { getOldDb, closeOldDb } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { loadMap } = require('./utils/maps');
const { section, info, success, warn, flushErrors } = require('./utils/logger');

function parseOldUserId(raw) {
  if (!raw) return null;
  const stripped = String(raw).replace(/^hh-/, '');
  const num = Number(stripped);
  return isNaN(num) ? null : num;
}

async function main() {
  section('Backfill missing User.phone for migrated consumers');

  const oldDb = getOldDb();
  const newDb = getNewDb();
  const companyMap = loadMap('companyMap.json');

  // Reverse: companyId → oldUserId
  const companyToOldUser = {};
  for (const [oldUserId, companyId] of Object.entries(companyMap)) {
    const parsed = parseOldUserId(oldUserId);
    if (parsed !== null) companyToOldUser[companyId] = parsed;
  }

  // Get consumers without phone
  const { rows: missing } = await newDb.query(`
    SELECT u.id AS "userId", u.email, u.name, cu."companyId"
    FROM users u
    JOIN corporate_users cu ON cu."userId" = u.id
    JOIN companies c ON c.id = cu."companyId"
    WHERE c."isConsumer" = true AND u.phone IS NULL
  `);
  info(`Consumers missing phone: ${missing.length}`);

  // Collect old user IDs to look up
  const toLookup = [];
  for (const row of missing) {
    const oldUserId = companyToOldUser[row.companyId];
    if (oldUserId) {
      toLookup.push({ ...row, oldUserId });
    } else {
      warn(`No old user mapping for company ${row.companyId} (user: ${row.email})`);
    }
  }
  info(`Users with old ID mapping: ${toLookup.length}`);

  if (toLookup.length === 0) {
    success('Nothing to backfill.');
    return;
  }

  // Bulk fetch phone numbers from old DB
  const oldUserIds = toLookup.map(r => r.oldUserId);
  const { rows: oldUsers } = await oldDb.query(`
    SELECT id, phone_number FROM public.users
    WHERE id = ANY($1::bigint[]) AND phone_number IS NOT NULL AND phone_number != ''
  `, [oldUserIds]);

  const phoneByOldId = {};
  for (const r of oldUsers) {
    phoneByOldId[Number(r.id)] = r.phone_number;
  }
  info(`Old users with phone numbers found: ${oldUsers.length}`);

  let updated = 0;
  let skipped = 0;
  let conflicts = 0;

  for (const row of toLookup) {
    const phone = phoneByOldId[row.oldUserId];
    if (!phone) {
      skipped++;
      continue;
    }

    // Check if this phone is already taken by another user
    const { rows: existing } = await newDb.query(`
      SELECT id, email FROM users WHERE phone = $1
    `, [phone]);

    if (existing.length > 0) {
      warn(`Phone ${phone} already belongs to user ${existing[0].email} — skipping ${row.email}`);
      conflicts++;
      continue;
    }

    await newDb.query(`UPDATE users SET phone = $1 WHERE id = $2`, [phone, row.userId]);
    info(`  Set phone ${phone} on ${row.email} (${row.name})`);
    updated++;
  }

  flushErrors();
  success(`Done!
  Missing: ${missing.length}
  With old ID mapping: ${toLookup.length}
  Updated: ${updated}
  Skipped (no old phone): ${skipped}
  Conflicts (phone taken): ${conflicts}`);
}

main()
  .catch(e => { console.error('Failed:', e); process.exit(1); })
  .finally(async () => {
    await closeOldDb();
    await closeNewDb();
  });
