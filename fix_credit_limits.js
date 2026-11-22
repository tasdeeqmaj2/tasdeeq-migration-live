const { Client } = require('pg');
const fs = require('fs');

const DRY_RUN = process.argv.includes('--dry-run');
const fixList = JSON.parse(fs.readFileSync('./fix_list.json', 'utf8'));

async function main() {
  const client = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', password: '12345678', database: 'tasdeeq' });
  await client.connect();
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Connected to new DB`);
  console.log(`Companies to fix: ${fixList.length}`);

  const results = { updated: [], skipped: [], errors: [] };

  for (const fix of fixList) {
    // Check current state (idempotent)
    const { rows } = await client.query(
      'SELECT name, "creditLimit" FROM companies WHERE id = $1', [fix.companyId]
    );
    if (!rows.length) {
      console.log(`  SKIP ${fix.companyName}: company not found`);
      results.skipped.push({ ...fix, reason: 'not_found' });
      continue;
    }

    const current = parseFloat(rows[0].creditLimit) || 0;
    if (current > 0) {
      console.log(`  SKIP ${fix.companyName}: already has creditLimit ${current} PKR`);
      results.skipped.push({ ...fix, reason: 'already_set', currentValue: current });
      continue;
    }

    if (DRY_RUN) {
      console.log(`  WOULD SET ${fix.companyName}: ${fix.creditLimit} PKR (ledger balance, old user ${fix.oldUserId}, match: ${fix.matchMethod})`);
      results.updated.push(fix);
    } else {
      try {
        await client.query(
          'UPDATE companies SET "creditLimit" = $1 WHERE id = $2 AND ("creditLimit" IS NULL OR "creditLimit" = 0)',
          [fix.creditLimit, fix.companyId]
        );
        console.log(`  SET ${fix.companyName}: ${fix.creditLimit} PKR`);
        results.updated.push(fix);
      } catch (e) {
        console.error(`  ERROR ${fix.companyName}: ${e.message}`);
        results.errors.push({ ...fix, error: e.message });
      }
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Updated: ${results.updated.length}`);
  console.log(`Skipped: ${results.skipped.length}`);
  console.log(`Errors: ${results.errors.length}`);
  console.log(`Total credit set: ${results.updated.reduce((s, r) => s + r.creditLimit, 0).toLocaleString()} PKR`);

  const logFile = DRY_RUN ? './fix_dry_run_log.json' : './fix_applied_log.json';
  fs.writeFileSync(logFile, JSON.stringify(results, null, 2));
  console.log(`Log: ${logFile}`);

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
