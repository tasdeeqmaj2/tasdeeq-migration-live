/**
 * Diagnose orphaned consumer companies and missing workers/credits.
 *
 * Connects to the LIVE DB (NEW_DATABASE_URL via SSH tunnel on 5433)
 * and the OLD DB (OLD_DATABASE_URL) to cross-reference.
 *
 * Usage:
 *   node diagnose-orphan-companies.js
 *
 * Output: console report + diagnose-results.json
 */

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');

const NEW_DB_URL = process.env.NEW_DATABASE_URL;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;

if (!NEW_DB_URL) { console.error('Set NEW_DATABASE_URL in .env'); process.exit(1); }

async function run() {
  const newDb = new Client({ connectionString: NEW_DB_URL });
  await newDb.connect();
  console.log('Connected to NEW (live) DB\n');

  let oldDb = null;
  if (OLD_DB_URL) {
    try {
      oldDb = new Client({ connectionString: OLD_DB_URL });
      await oldDb.connect();
      console.log('Connected to OLD DB\n');
    } catch (e) {
      console.log('Could not connect to OLD DB, skipping old data checks\n');
      oldDb = null;
    }
  }

  const results = {};

  // ─── 1. Find all orphaned consumer companies with workers ───
  console.log('═══════════════════════════════════════════════════════');
  console.log('1. ORPHANED CONSUMER COMPANIES (have workers, no user)');
  console.log('═══════════════════════════════════════════════════════\n');

  const { rows: orphans } = await newDb.query(`
    SELECT c.id, c.name, c.email, c."creditLimit",
           (SELECT COUNT(*)::int FROM workers w WHERE w."companyId" = c.id) AS worker_count
    FROM companies c
    WHERE c."isConsumer" = true
      AND NOT EXISTS (SELECT 1 FROM corporate_users cu WHERE cu."companyId" = c.id)
      AND (SELECT COUNT(*) FROM workers w WHERE w."companyId" = c.id) > 0
    ORDER BY worker_count DESC
  `);

  console.log(`Found ${orphans.length} orphaned consumer companies with workers:\n`);
  for (const o of orphans) {
    console.log(`  ${o.name} (${o.id}): ${o.worker_count} workers, credit: ${o.creditLimit ?? 'NULL'}`);
  }
  results.orphans = orphans;

  // ─── 2. Match orphans to corporate companies ───
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('2. MATCHING ORPHANS TO CORPORATE COMPANIES');
  console.log('═══════════════════════════════════════════════════════\n');

  const matchResults = [];

  for (const orphan of orphans) {
    // Try exact name match
    const { rows: nameMatches } = await newDb.query(`
      SELECT c.id, c.name, c."creditLimit",
             (SELECT COUNT(*)::int FROM workers w WHERE w."companyId" = c.id) AS worker_count
      FROM companies c
      WHERE LOWER(TRIM(c.name)) = LOWER(TRIM($1))
        AND c."isConsumer" = false
        AND c.id != $2
        AND EXISTS (SELECT 1 FROM corporate_users cu WHERE cu."companyId" = c.id)
    `, [orphan.name, orphan.id]);

    // Check duplicates between orphan and each match
    for (const match of nameMatches) {
      const { rows: [{ dup_count }] } = await newDb.query(`
        SELECT COUNT(*)::int AS dup_count
        FROM workers w1
        WHERE w1."companyId" = $1
          AND w1.cnic IS NOT NULL AND w1.cnic != ''
          AND EXISTS (
            SELECT 1 FROM workers w2
            WHERE w2."companyId" = $2 AND w2.cnic = w1.cnic
          )
      `, [orphan.id, match.id]);

      const unique_to_orphan = orphan.worker_count - dup_count;

      matchResults.push({
        orphan_id: orphan.id,
        orphan_name: orphan.name,
        orphan_workers: orphan.worker_count,
        orphan_credit: orphan.creditLimit,
        corp_id: match.id,
        corp_name: match.name,
        corp_workers: match.worker_count,
        corp_credit: match.creditLimit,
        duplicate_cnics: dup_count,
        unique_to_orphan: unique_to_orphan,
      });
    }

    if (nameMatches.length === 0) {
      matchResults.push({
        orphan_id: orphan.id,
        orphan_name: orphan.name,
        orphan_workers: orphan.worker_count,
        orphan_credit: orphan.creditLimit,
        corp_id: null,
        corp_name: null,
        corp_workers: null,
        corp_credit: null,
        duplicate_cnics: 0,
        unique_to_orphan: orphan.worker_count,
      });
    }
  }

  const matched = matchResults.filter(m => m.corp_id);
  const unmatched = matchResults.filter(m => !m.corp_id);

  console.log(`MATCHED (orphan → corporate company):`);
  for (const m of matched) {
    console.log(`  ${m.orphan_name}:`);
    console.log(`    Orphan: ${m.orphan_workers} workers (credit: ${m.orphan_credit ?? 'NULL'})`);
    console.log(`    Corp:   ${m.corp_workers} workers (credit: ${m.corp_credit ?? 'NULL'}) → ${m.corp_id}`);
    console.log(`    Duplicates: ${m.duplicate_cnics}, Unique to move: ${m.unique_to_orphan}`);
  }

  console.log(`\nUNMATCHED (no corporate company found):`);
  for (const m of unmatched) {
    console.log(`  ${m.orphan_name}: ${m.orphan_workers} workers (credit: ${m.orphan_credit ?? 'NULL'})`);
  }

  results.matched = matched;
  results.unmatched = unmatched;

  // ─── 3. Detailed duplicate analysis for matched companies ───
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('3. DUPLICATE WORKER ANALYSIS (for matched companies)');
  console.log('═══════════════════════════════════════════════════════\n');

  for (const m of matched) {
    if (m.duplicate_cnics === 0) continue;

    const { rows: dups } = await newDb.query(`
      SELECT
        w1.cnic,
        w1.name AS orphan_name, w1.id AS orphan_worker_id,
        w2.name AS corp_name, w2.id AS corp_worker_id,
        (SELECT COUNT(*)::int FROM verification_tasks vt WHERE vt."workerId" = w1.id) AS orphan_tasks,
        (SELECT COUNT(*)::int FROM verification_tasks vt WHERE vt."workerId" = w2.id) AS corp_tasks
      FROM workers w1
      JOIN workers w2 ON w2.cnic = w1.cnic AND w2."companyId" = $2
      WHERE w1."companyId" = $1
        AND w1.cnic IS NOT NULL AND w1.cnic != ''
      LIMIT 20
    `, [m.orphan_id, m.corp_id]);

    console.log(`  ${m.orphan_name} → ${m.corp_name}: ${m.duplicate_cnics} duplicates`);
    for (const d of dups) {
      console.log(`    CNIC ${d.cnic}: orphan "${d.orphan_name}" (${d.orphan_tasks} tasks) ↔ corp "${d.corp_name}" (${d.corp_tasks} tasks)`);
    }
    m.duplicate_details = dups;
  }

  // ─── 4. Check old user_available_verifications ───
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('4. OLD AVAILABLE UNITS (user_available_verifications)');
  console.log('═══════════════════════════════════════════════════════\n');

  // Check in new DB
  const { rows: [{ table_exists_new }] } = await newDb.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'user_available_verifications'
    ) AS table_exists_new
  `);

  if (table_exists_new) {
    const { rows: uavNew } = await newDb.query(`
      SELECT * FROM user_available_verifications LIMIT 10
    `);
    console.log(`user_available_verifications exists in NEW DB: ${uavNew.length} sample rows`);
    console.log(JSON.stringify(uavNew, null, 2));
    results.uav_in_new_db = true;
  } else {
    console.log('user_available_verifications does NOT exist in new DB');
    results.uav_in_new_db = false;
  }

  // Check in old DB
  if (oldDb) {
    try {
      const { rows: [{ table_exists_old }] } = await oldDb.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_name = 'user_available_verification'
        ) AS table_exists_old
      `);

      if (table_exists_old) {
        const { rows: uavOld } = await oldDb.query(`
          SELECT COUNT(*)::int AS total,
                 SUM(CASE WHEN units > 0 THEN 1 ELSE 0 END)::int AS with_units
          FROM user_available_verification
        `);
        console.log(`\nuser_available_verification in OLD DB: ${uavOld[0].total} rows, ${uavOld[0].with_units} with units > 0`);

        // Cross-reference with orphaned companies
        const { rows: uavSample } = await oldDb.query(`
          SELECT uav.user_id, uav.units, u.name, u.email
          FROM user_available_verification uav
          LEFT JOIN users u ON u.id = uav.user_id
          WHERE uav.units > 0
          ORDER BY uav.units DESC
          LIMIT 20
        `);
        console.log('\nTop 20 users with available units in OLD DB:');
        for (const r of uavSample) {
          console.log(`  ${r.name ?? 'unknown'} (${r.email ?? r.user_id}): ${r.units} units`);
        }
        results.old_uav = uavSample;
      } else {
        console.log('\nuser_available_verification does NOT exist in old DB');
        results.old_uav = null;
      }
    } catch (e) {
      console.log('\nError checking old DB:', e.message);
    }
  }

  // ─── 5. Credit limit comparison ───
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('5. CREDIT LIMIT COMPARISON (orphan vs corporate)');
  console.log('═══════════════════════════════════════════════════════\n');

  const { rows: creditMismatches } = await newDb.query(`
    SELECT
      o.id AS orphan_id, o.name, o."creditLimit" AS orphan_credit,
      c.id AS corp_id, c.name AS corp_name, c."creditLimit" AS corp_credit
    FROM companies o
    JOIN companies c ON LOWER(TRIM(c.name)) = LOWER(TRIM(o.name))
      AND c."isConsumer" = false
      AND c.id != o.id
      AND EXISTS (SELECT 1 FROM corporate_users cu WHERE cu."companyId" = c.id)
    WHERE o."isConsumer" = true
      AND NOT EXISTS (SELECT 1 FROM corporate_users cu WHERE cu."companyId" = o.id)
      AND (o."creditLimit" IS NOT NULL OR c."creditLimit" IS NOT NULL)
  `);

  if (creditMismatches.length === 0) {
    console.log('No credit limit mismatches found (both NULL or both set equally)');
  } else {
    for (const cm of creditMismatches) {
      console.log(`  ${cm.name}: orphan credit=${cm.orphan_credit ?? 'NULL'}, corp credit=${cm.corp_credit ?? 'NULL'}`);
    }
  }
  results.credit_mismatches = creditMismatches;

  // ─── 6. Summary ───
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════\n');

  const totalOrphanWorkers = orphans.reduce((s, o) => s + o.worker_count, 0);
  const totalMatchedOrphanWorkers = matched.reduce((s, m) => s + m.orphan_workers, 0);
  const totalDuplicates = matched.reduce((s, m) => s + m.duplicate_cnics, 0);
  const totalUniqueToMove = matched.reduce((s, m) => s + m.unique_to_orphan, 0);

  console.log(`Orphaned consumer companies:    ${orphans.length}`);
  console.log(`  With corporate match:         ${matched.length}`);
  console.log(`  Without match (truly orphan):  ${unmatched.length}`);
  console.log(`Total orphan workers:            ${totalOrphanWorkers}`);
  console.log(`  In matched companies:          ${totalMatchedOrphanWorkers}`);
  console.log(`    Duplicate CNICs:             ${totalDuplicates}`);
  console.log(`    Unique (safe to move):       ${totalUniqueToMove}`);
  console.log(`  In unmatched companies:        ${totalOrphanWorkers - totalMatchedOrphanWorkers}`);

  results.summary = {
    total_orphan_companies: orphans.length,
    matched_companies: matched.length,
    unmatched_companies: unmatched.length,
    total_orphan_workers: totalOrphanWorkers,
    matched_orphan_workers: totalMatchedOrphanWorkers,
    duplicate_cnics: totalDuplicates,
    unique_to_move: totalUniqueToMove,
    unmatched_workers: totalOrphanWorkers - totalMatchedOrphanWorkers,
  };

  // Save results
  const outPath = __dirname + '/diagnose-results.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outPath}`);

  await newDb.end();
  if (oldDb) await oldDb.end();
}

run().catch(e => { console.error(e); process.exit(1); });
