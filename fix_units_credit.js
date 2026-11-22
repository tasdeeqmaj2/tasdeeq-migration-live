const { Client } = require('pg');
const fixList = require('./fix_units_credit.json');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const client = new Client({
    host: 'localhost',
    port: 5433,
    database: 'tasdeeq',
    user: 'tasdeeq',
    password: 'tasdeeq_dev',
  });
  await client.connect();

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Fixing ${fixList.length} companies to honor old system units...\n`);

  let updated = 0;
  let skipped = 0;
  let totalCredit = 0;

  for (const item of fixList) {
    const res = await client.query(
      'SELECT "creditLimit" FROM companies WHERE id = $1',
      [item.companyId]
    );

    if (res.rows.length === 0) {
      console.log(`SKIP ${item.name} (${item.companyId}) — company not found`);
      skipped++;
      continue;
    }

    const current = Number(res.rows[0].creditLimit ?? 0);

    if (current === item.newCreditLimit) {
      console.log(`SKIP ${item.name} — already at ${item.newCreditLimit}`);
      skipped++;
      continue;
    }

    console.log(`${DRY_RUN ? '[DRY] ' : ''}UPDATE ${item.name}: ${current} → ${item.newCreditLimit} (${item.oldUnits} units)`);

    if (!DRY_RUN) {
      await client.query(
        'UPDATE companies SET "creditLimit" = $1 WHERE id = $2',
        [item.newCreditLimit, item.companyId]
      );
    }

    updated++;
    totalCredit += item.newCreditLimit;
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}, Total credit set: ${totalCredit.toLocaleString()} PKR`);

  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });
