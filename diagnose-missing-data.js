/**
 * Diagnose missing data on production vs local DB.
 * Compares counts and finds specific missing records.
 *
 * Usage:
 *   node diagnose-missing-data.js
 *   (requires DATABASE_URL env for prod)
 *   DATABASE_URL="..." node diagnose-missing-data.js
 */

const { Client } = require('pg');

const LOCAL_URL = 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
const PROD_URL = process.env.DATABASE_URL;

if (!PROD_URL) {
  console.error('Set DATABASE_URL env var for production.');
  process.exit(1);
}

async function connect(url, name, ssl) {
  const c = new Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : false });
  await c.connect();
  console.log(`Connected to ${name}`);
  return c;
}

async function main() {
  const local = await connect(LOCAL_URL, 'LOCAL');
  const prod = await connect(PROD_URL, 'PRODUCTION', true);

  // 1. Table counts comparison
  const tables = [
    'users', 'companies', 'corporate_users', 'workers',
    'verification_tasks', 'criminal_verification_forms',
    'invoices', 'invoice_items', 'credit_statuses',
    'cplc_verification_reviews', 'worker_activities',
    'sessions', 'login_otps', 'banners', 'notifications',
    'job_schedules', 'notification_templates',
  ];

  console.log('\n=== TABLE COUNTS ===');
  console.log('Table'.padEnd(35) + 'Local'.padStart(8) + 'Prod'.padStart(8) + '  Diff');
  console.log('-'.repeat(60));

  for (const t of tables) {
    try {
      const [lr, pr] = await Promise.all([
        local.query(`SELECT COUNT(*)::int AS cnt FROM "${t}"`),
        prod.query(`SELECT COUNT(*)::int AS cnt FROM "${t}"`),
      ]);
      const lc = lr.rows[0].cnt;
      const pc = pr.rows[0].cnt;
      const diff = pc - lc;
      const marker = diff < 0 ? ' ← MISSING' : diff > 0 ? ' (extra)' : '';
      console.log(`${t.padEnd(35)}${String(lc).padStart(8)}${String(pc).padStart(8)}  ${diff >= 0 ? '+' : ''}${diff}${marker}`);
    } catch (e) {
      console.log(`${t.padEnd(35)} ERROR: ${e.message.slice(0, 50)}`);
    }
  }

  // 2. Verification tasks by status
  console.log('\n=== VERIFICATION TASKS BY STATUS ===');
  const statusQuery = `SELECT status, COUNT(*)::int AS cnt FROM verification_tasks GROUP BY status ORDER BY status`;
  const [ls, ps] = await Promise.all([local.query(statusQuery), prod.query(statusQuery)]);
  const localStatuses = Object.fromEntries(ls.rows.map(r => [r.status, r.cnt]));
  const prodStatuses = Object.fromEntries(ps.rows.map(r => [r.status, r.cnt]));
  const allStatuses = [...new Set([...Object.keys(localStatuses), ...Object.keys(prodStatuses)])].sort();
  console.log('Status'.padEnd(20) + 'Local'.padStart(8) + 'Prod'.padStart(8) + '  Diff');
  for (const s of allStatuses) {
    const l = localStatuses[s] || 0;
    const p = prodStatuses[s] || 0;
    const diff = p - l;
    console.log(`${s.padEnd(20)}${String(l).padStart(8)}${String(p).padStart(8)}  ${diff >= 0 ? '+' : ''}${diff}`);
  }

  // 3. Companies with credit_statuses
  console.log('\n=== CREDIT STATUS ===');
  const creditQuery = `
    SELECT COUNT(DISTINCT c.id)::int AS total_companies,
           COUNT(DISTINCT cs.id)::int AS with_credit,
           SUM(CASE WHEN cs."availableUnits" > 0 THEN 1 ELSE 0 END)::int AS with_units
    FROM companies c
    LEFT JOIN credit_statuses cs ON cs."companyId" = c.id
  `;
  const [lc, pc] = await Promise.all([local.query(creditQuery), prod.query(creditQuery)]);
  console.log('Metric'.padEnd(30) + 'Local'.padStart(8) + 'Prod'.padStart(8));
  console.log(`${'Total companies'.padEnd(30)}${String(lc.rows[0].total_companies).padStart(8)}${String(pc.rows[0].total_companies).padStart(8)}`);
  console.log(`${'With credit_status'.padEnd(30)}${String(lc.rows[0].with_credit).padStart(8)}${String(pc.rows[0].with_credit).padStart(8)}`);
  console.log(`${'With available units > 0'.padEnd(30)}${String(lc.rows[0].with_units).padStart(8)}${String(pc.rows[0].with_units).padStart(8)}`);

  // 4. Workers missing on prod (by CNIC)
  console.log('\n=== WORKERS COMPARISON (by CNIC) ===');
  const workerQuery = `SELECT cnic FROM workers WHERE cnic IS NOT NULL AND cnic != ''`;
  const [lw, pw] = await Promise.all([local.query(workerQuery), prod.query(workerQuery)]);
  const localCnics = new Set(lw.rows.map(r => r.cnic));
  const prodCnics = new Set(pw.rows.map(r => r.cnic));
  const missingOnProd = [...localCnics].filter(c => !prodCnics.has(c));
  const extraOnProd = [...prodCnics].filter(c => !localCnics.has(c));
  console.log(`Local unique CNICs: ${localCnics.size}`);
  console.log(`Prod unique CNICs: ${prodCnics.size}`);
  console.log(`Missing on prod: ${missingOnProd.length}`);
  console.log(`Extra on prod: ${extraOnProd.length}`);
  if (missingOnProd.length > 0 && missingOnProd.length <= 20) {
    console.log('Missing CNICs:', missingOnProd.join(', '));
  }

  // 5. Verifications with missing images (CNIC front/back, photo)
  console.log('\n=== VERIFICATIONS WITH MISSING IMAGES (prod) ===');
  const imgQuery = `
    SELECT
      COUNT(*)::int AS total_forms,
      SUM(CASE WHEN cf."cnicFrontImage" IS NULL OR cf."cnicFrontImage" = '' THEN 1 ELSE 0 END)::int AS no_cnic_front,
      SUM(CASE WHEN cf."cnicBackImage" IS NULL OR cf."cnicBackImage" = '' THEN 1 ELSE 0 END)::int AS no_cnic_back,
      SUM(CASE WHEN cf."workerPhoto" IS NULL OR cf."workerPhoto" = '' THEN 1 ELSE 0 END)::int AS no_photo
    FROM criminal_verification_forms cf
    JOIN verification_tasks vt ON vt.id = cf."taskId"
    WHERE vt.status IN ('PENDING', 'ASSIGNED', 'COMPLETED')
  `;
  const [li, pi] = await Promise.all([local.query(imgQuery), prod.query(imgQuery)]);
  console.log('Metric'.padEnd(30) + 'Local'.padStart(8) + 'Prod'.padStart(8));
  console.log(`${'Total forms (active)'.padEnd(30)}${String(li.rows[0].total_forms).padStart(8)}${String(pi.rows[0].total_forms).padStart(8)}`);
  console.log(`${'Missing CNIC front'.padEnd(30)}${String(li.rows[0].no_cnic_front).padStart(8)}${String(pi.rows[0].no_cnic_front).padStart(8)}`);
  console.log(`${'Missing CNIC back'.padEnd(30)}${String(li.rows[0].no_cnic_back).padStart(8)}${String(pi.rows[0].no_cnic_back).padStart(8)}`);
  console.log(`${'Missing worker photo'.padEnd(30)}${String(li.rows[0].no_photo).padStart(8)}${String(pi.rows[0].no_photo).padStart(8)}`);

  // 6. Check image paths — are they S3 keys or empty?
  console.log('\n=== SAMPLE MISSING IMAGES ON PROD ===');
  const sampleQuery = `
    SELECT vt.id AS task_id, w.name AS worker_name, w.cnic,
           cf."cnicFrontImage", cf."cnicBackImage", cf."workerPhoto"
    FROM criminal_verification_forms cf
    JOIN verification_tasks vt ON vt.id = cf."taskId"
    JOIN workers w ON w.id = vt."workerId"
    WHERE vt.status IN ('PENDING', 'ASSIGNED', 'COMPLETED')
      AND (cf."cnicFrontImage" IS NULL OR cf."cnicFrontImage" = ''
        OR cf."cnicBackImage" IS NULL OR cf."cnicBackImage" = ''
        OR cf."workerPhoto" IS NULL OR cf."workerPhoto" = '')
    LIMIT 10
  `;
  const sr = await prod.query(sampleQuery);
  for (const r of sr.rows) {
    console.log(`  Task ${r.task_id} | ${r.worker_name} (${r.cnic}) | front: ${r.cnicFrontImage || 'NULL'} | back: ${r.cnicBackImage || 'NULL'} | photo: ${r.workerPhoto || 'NULL'}`);
  }

  // 7. Users comparison
  console.log('\n=== USERS BY ROLE ===');
  const roleQuery = `SELECT role, COUNT(*)::int AS cnt FROM users GROUP BY role ORDER BY role`;
  const [lru, pru] = await Promise.all([local.query(roleQuery), prod.query(roleQuery)]);
  const localRoles = Object.fromEntries(lru.rows.map(r => [r.role, r.cnt]));
  const prodRoles = Object.fromEntries(pru.rows.map(r => [r.role, r.cnt]));
  const allRoles = [...new Set([...Object.keys(localRoles), ...Object.keys(prodRoles)])].sort();
  console.log('Role'.padEnd(20) + 'Local'.padStart(8) + 'Prod'.padStart(8) + '  Diff');
  for (const r of allRoles) {
    const l = localRoles[r] || 0;
    const p = prodRoles[r] || 0;
    console.log(`${r.padEnd(20)}${String(l).padStart(8)}${String(p).padStart(8)}  ${(p - l >= 0 ? '+' : '')}${p - l}`);
  }

  await local.end();
  await prod.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
