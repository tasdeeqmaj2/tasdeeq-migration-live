/**
 * Resolve unmatched orphan companies by finding the original user email
 * from the OLD DB, then matching to corporate accounts in NEW DB.
 *
 * Usage: node resolve-unmatched.js
 */

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;

if (!NEW_DB_URL || !OLD_DB_URL) {
  console.error('Set both NEW_DATABASE_URL and OLD_DATABASE_URL in .env');
  process.exit(1);
}

const SSL = { rejectUnauthorized: false };

// Orphans that had no name match — the big ones we care about
// (skipping generic names like Ali, abc, dasdas, Testing, pasha, dsa, alpha, etc.)
const UNMATCHED_ORPHANS = [
  { id: 'cmwpcwaov7dc0df8bfa93284b', name: 'Foodpanda', email: 'migrated-59103@consumer.tasdeeq.app', workers: 5627 },
  { id: 'cmwpcvr4a0e73cd6b406b39b8', name: 'Hilal Foods', email: 'migrated-59062@consumer.tasdeeq.app', workers: 4446 },
  { id: 'cmwpcv6rda2c125c86f14ec24', name: 'Osama Moin Moin Chawla', email: 'migrated-56137@consumer.tasdeeq.app', workers: 925 },
  { id: 'cmwpcxdjsc397b5e5bba5c48b', name: 'Naval Anchorage Islamabad', email: 'migrated-60136@consumer.tasdeeq.app', workers: 186 },
  { id: 'cmwpcvqbe93a21dfd3fb1ebc2', name: 'Anis Apparel', email: 'migrated-58855@consumer.tasdeeq.app', workers: 33 },
  { id: 'cmwpcus8ye0aa4125f2059cb7', name: 'Pasha & co', email: 'migrated-53253@consumer.tasdeeq.app', workers: 26 },
  { id: 'cmwpcvfx1966eaefd30089552', name: 'Cool Man & Co', email: 'migrated-56996@consumer.tasdeeq.app', workers: 13 },
  { id: 'cmwpcy99x1d469f39fd9d3ba1', name: 'Orchards Cottage Hotel', email: 'migrated-65943@consumer.tasdeeq.app', workers: 12 },
  { id: 'cmwpcxsvw4e1f6f837a7b8356', name: 'Essa Lab', email: 'migrated-63157@consumer.tasdeeq.app', workers: 5 },
  { id: 'cmwpcxes802ad80947526fd43', name: 'Keenan OOne', email: 'migrated-60240@consumer.tasdeeq.app', workers: 5 },
  { id: 'cmwpcvhqi2f2f22b33581f967', name: 'Pakistan Cotton Nappies', email: 'migrated-57208@consumer.tasdeeq.app', workers: 3 },
  { id: 'cmwpcvbrm5baae434b703264b', name: 'Janjua & Company', email: 'migrated-56235@consumer.tasdeeq.app', workers: 2 },
  { id: 'cmwpcxzos3b031c2861951615', name: 'Sarimad security services Pvt ltd', email: 'migrated-64485@consumer.tasdeeq.app', workers: 2 },
  { id: 'cmwpctl91b9665ca316dc9d5f', name: 'EFU Life', email: 'migrated-44277@consumer.tasdeeq.app', workers: 2 },
  { id: 'cmwpcvgrr14bf2dd412498312', name: 'Shahid Afridi Foundation', email: 'migrated-57027@consumer.tasdeeq.app', workers: 1 },
  { id: 'cmwpcxwqz93ea0e3c5ec06bb0', name: 'Griffin Security Services Private Limited', email: 'migrated-63967@consumer.tasdeeq.app', workers: 1 },
  { id: 'cmwpcy5l5e3d336425c1d6a9b', name: 'Essa Engineering Industries Private Limited', email: 'migrated-65364@consumer.tasdeeq.app', workers: 1 },
  { id: 'cmwpcvc869dcdfdaaaf3dc704', name: 'TAALEM', email: 'migrated-56327@consumer.tasdeeq.app', workers: 1 },
  { id: 'cmwpctl17b73b9a65ecee0702', name: 'Tasdeeq (Pvt) Ltd', email: 'migrated-44250@consumer.tasdeeq.app', workers: 1 },
  { id: 'cmwpcv0067507078c863c7440', name: 'Century Insurance ', email: 'migrated-54813@consumer.tasdeeq.app', workers: 1 },
];

// Also resolve Lucky Cement — which of the 5 corp companies is the real one?
const LUCKY_CEMENT_ORPHAN = {
  id: 'cmwpcx1s66225e84a0e032f0c',
  email: 'migrated-59493@consumer.tasdeeq.app',
  workers: 2200,
};

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  await newDb.connect();
  await oldDb.connect();
  console.log('Connected to both DBs\n');

  const results = [];

  // Extract old user ID from migrated email pattern: migrated-{id}@consumer.tasdeeq.app
  function extractOldId(email) {
    if (!email) return null;
    const m = email.match(/^migrated-(\d+)@consumer\.tasdeeq\.app$/);
    return m ? m[1] : null;
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('RESOLVING UNMATCHED ORPHANS VIA OLD DB USER EMAIL');
  console.log('═══════════════════════════════════════════════════════\n');

  const allOrphans = [...UNMATCHED_ORPHANS, { ...LUCKY_CEMENT_ORPHAN, name: 'LUCKY CEMENT LIMITED' }];

  for (const orphan of allOrphans) {
    const oldId = extractOldId(orphan.email);
    if (!oldId) {
      console.log(`  ${orphan.name}: no migrated ID in email "${orphan.email}"`);
      results.push({ ...orphan, old_id: null, old_email: null, old_phone: null, corp_match: null });
      continue;
    }

    // Look up user in old DB
    const { rows: oldUsers } = await oldDb.query(
      `SELECT id, name, email, phone FROM "user" WHERE id = $1`,
      [oldId]
    );

    if (oldUsers.length === 0) {
      console.log(`  ${orphan.name}: old user ID ${oldId} not found in old DB`);
      results.push({ ...orphan, old_id: oldId, old_email: null, old_phone: null, corp_match: null });
      continue;
    }

    const oldUser = oldUsers[0];
    console.log(`  ${orphan.name}:`);
    console.log(`    Old user: ${oldUser.name} | ${oldUser.email} | ${oldUser.phone}`);

    // Now find this email or phone in the new DB as a corporate user
    let corpMatch = null;

    if (oldUser.email) {
      // Check if this email exists as a user in new DB
      const { rows: newUsers } = await newDb.query(
        `SELECT u.id, u.name, u.email, u.role
         FROM users u
         WHERE LOWER(u.email) = LOWER($1)`,
        [oldUser.email]
      );

      for (const nu of newUsers) {
        // Find their corporate company
        const { rows: corps } = await newDb.query(
          `SELECT cu."companyId", cu.role AS corp_role, c.name AS company_name,
                  c."isConsumer",
                  (SELECT COUNT(*)::int FROM workers w WHERE w."companyId" = cu."companyId") AS worker_count
           FROM corporate_users cu
           JOIN companies c ON c.id = cu."companyId"
           WHERE cu."userId" = $1`,
          [nu.id]
        );

        if (corps.length > 0) {
          console.log(`    NEW DB user: ${nu.name} (${nu.email}) role=${nu.role}`);
          for (const corp of corps) {
            console.log(`      → Company: "${corp.company_name}" (${corp.companyId}) isConsumer=${corp.isConsumer} workers=${corp.worker_count} role=${corp.corp_role}`);
          }
          // Pick the non-consumer company with most workers as the target
          const realCorp = corps.filter(c => !c.isConsumer).sort((a, b) => b.worker_count - a.worker_count)[0];
          if (realCorp) {
            corpMatch = {
              user_id: nu.id,
              user_email: nu.email,
              company_id: realCorp.companyId,
              company_name: realCorp.company_name,
              company_workers: realCorp.worker_count,
            };
          }
        }
      }
    }

    // Also try phone match if email didn't work
    if (!corpMatch && oldUser.phone) {
      const { rows: phoneUsers } = await newDb.query(
        `SELECT u.id, u.name, u.email, u.role
         FROM users u
         WHERE u.phone = $1 OR u.phone = $2`,
        [oldUser.phone, oldUser.phone.replace(/^0/, '+92')]
      );

      for (const pu of phoneUsers) {
        const { rows: corps } = await newDb.query(
          `SELECT cu."companyId", cu.role AS corp_role, c.name AS company_name,
                  c."isConsumer",
                  (SELECT COUNT(*)::int FROM workers w WHERE w."companyId" = cu."companyId") AS worker_count
           FROM corporate_users cu
           JOIN companies c ON c.id = cu."companyId"
           WHERE cu."userId" = $1`,
          [pu.id]
        );

        if (corps.length > 0) {
          console.log(`    NEW DB user (phone match): ${pu.name} (${pu.email}) role=${pu.role}`);
          for (const corp of corps) {
            console.log(`      → Company: "${corp.company_name}" (${corp.companyId}) isConsumer=${corp.isConsumer} workers=${corp.worker_count} role=${corp.corp_role}`);
          }
          const realCorp = corps.filter(c => !c.isConsumer).sort((a, b) => b.worker_count - a.worker_count)[0];
          if (realCorp) {
            corpMatch = {
              user_id: pu.id,
              user_email: pu.email,
              company_id: realCorp.companyId,
              company_name: realCorp.company_name,
              company_workers: realCorp.worker_count,
              matched_via: 'phone',
            };
          }
        }
      }
    }

    if (corpMatch) {
      // Count duplicates
      const { rows: [{ dup_count }] } = await newDb.query(`
        SELECT COUNT(*)::int AS dup_count
        FROM workers w1
        WHERE w1."companyId" = $1
          AND w1.cnic IS NOT NULL AND w1.cnic != ''
          AND EXISTS (
            SELECT 1 FROM workers w2
            WHERE w2."companyId" = $2 AND w2.cnic = w1.cnic
          )
      `, [orphan.id, corpMatch.company_id]);

      corpMatch.duplicate_cnics = dup_count;
      corpMatch.unique_to_move = orphan.workers - dup_count;
      console.log(`    ✓ MATCH: "${corpMatch.company_name}" (${corpMatch.company_id})`);
      console.log(`      Corp workers: ${corpMatch.company_workers}, Duplicates: ${dup_count}, Unique to move: ${corpMatch.unique_to_move}`);
    } else {
      console.log(`    ✗ No corporate account found in new DB`);
    }

    results.push({
      orphan_id: orphan.id,
      orphan_name: orphan.name,
      orphan_workers: orphan.workers,
      old_id: oldId,
      old_email: oldUser.email,
      old_phone: oldUser.phone,
      old_name: oldUser.name,
      corp_match: corpMatch,
    });
  }

  // Also check old DB available units for these users
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('OLD AVAILABLE UNITS FOR THESE USERS');
  console.log('═══════════════════════════════════════════════════════\n');

  for (const r of results) {
    if (!r.old_id) continue;
    try {
      const { rows } = await oldDb.query(
        `SELECT units FROM user_available_verification WHERE user_id = $1`,
        [r.old_id]
      );
      if (rows.length > 0 && rows[0].units > 0) {
        r.old_units = rows[0].units;
        console.log(`  ${r.orphan_name}: ${rows[0].units} units in old DB`);
      }
    } catch (e) { /* table might not exist */ }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════\n');

  const matched = results.filter(r => r.corp_match);
  const unmatched = results.filter(r => !r.corp_match);

  console.log(`Resolved: ${matched.length} orphans → corporate companies`);
  for (const m of matched) {
    console.log(`  ${m.orphan_name} (${m.orphan_workers} workers) → "${m.corp_match.company_name}" (${m.corp_match.company_workers} existing, ${m.corp_match.unique_to_move} to move)`);
  }

  console.log(`\nStill unmatched: ${unmatched.length}`);
  for (const u of unmatched) {
    console.log(`  ${u.orphan_name} (${u.orphan_workers} workers) — old email: ${u.old_email ?? 'unknown'}`);
  }

  const outPath = __dirname + '/resolve-results.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outPath}`);

  await newDb.end();
  await oldDb.end();
}

run().catch(e => { console.error(e); process.exit(1); });
