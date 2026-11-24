/**
 * Fix: insert CPLC reviews for orphan-worker tasks that were just created
 * but whose CPLC reviews failed due to wrong reviewerId.
 *
 * Only inserts reviews for tasks that don't already have one.
 *
 * Usage:
 *   DATABASE_URL="<new>" OLD_DATABASE_URL="<old>" node fix-orphan-cplc-reviews.js --prod --dry-run
 *   DATABASE_URL="<new>" OLD_DATABASE_URL="<old>" node fix-orphan-cplc-reviews.js --prod --apply
 */

const { Client } = require('pg');
const crypto = require('crypto');
const { decryptLegacy } = require('./utils/decrypt');

const PROD = process.argv.includes('--prod');
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

let NEW_URL, OLD_URL;
if (PROD) {
  NEW_URL = process.env.DATABASE_URL;
  OLD_URL = process.env.OLD_DATABASE_URL;
} else {
  require('dotenv').config();
  NEW_URL = 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
  OLD_URL = process.env.OLD_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5432/tasdeeq-prod-dump';
}

if (!NEW_URL || !OLD_URL) { console.error('Set DATABASE_URL and OLD_DATABASE_URL'); process.exit(1); }

function createId() {
  return 'cm' + Date.now().toString(36) + crypto.randomBytes(12).toString('hex').slice(0, 23);
}
function normalize(cnic) { return cnic ? cnic.replace(/[-\s]/g, '') : null; }
function decryptCnic(val) {
  if (!val) return null;
  return decryptLegacy(String(val).trim());
}
function mapCplcVerdict(status) {
  if (!status) return null;
  const s = String(status).trim().toLowerCase();
  if (/reject|fail|deni/.test(s)) return 'REJECTED';
  if (/skip/.test(s)) return 'SKIPPED';
  if (/approv|verif|complet|success|clear|pass/.test(s)) return 'APPROVED';
  return null;
}

async function main() {
  const newDb = new Client({ connectionString: NEW_URL, ssl: PROD ? { rejectUnauthorized: false } : false });
  const oldDb = new Client({ connectionString: OLD_URL, ssl: PROD ? { rejectUnauthorized: false } : false });
  await newDb.connect();
  await oldDb.connect();
  console.log(`${DRY_RUN ? '[DRY RUN] ' : '[APPLY] '}${PROD ? '[PROD] ' : '[LOCAL] '}Connected.\n`);

  // 1. Get a valid CPLC reviewer (userId from cplc_users, which references users.id)
  const { rows: cplcUsers } = await newDb.query(`SELECT "userId" FROM cplc_users LIMIT 1`);
  if (cplcUsers.length === 0) {
    console.error('No CPLC users found — cannot create reviews.');
    process.exit(1);
  }
  const cplcReviewerId = cplcUsers[0].userId;
  console.log(`CPLC reviewer userId: ${cplcReviewerId}`);

  // Verify this user exists in the users table
  const { rows: [userCheck] } = await newDb.query(`SELECT id, email FROM users WHERE id = $1`, [cplcReviewerId]);
  if (!userCheck) {
    console.error(`Reviewer ${cplcReviewerId} not found in users table!`);
    process.exit(1);
  }
  console.log(`Reviewer verified: ${userCheck.email}\n`);

  // 2. Find tasks that have NO cplc_verification_review yet
  //    (these are the ones from the fix-orphan-workers run where CPLC insert failed)
  console.log('Finding tasks without CPLC reviews...');
  const { rows: tasksWithoutReview } = await newDb.query(`
    SELECT vt.id AS task_id, w.cnic
    FROM verification_tasks vt
    JOIN workers w ON w.id = vt."workerId"
    LEFT JOIN cplc_verification_reviews cr ON cr."taskId" = vt.id
    WHERE cr.id IS NULL
      AND vt.status = 'COMPLETED'
      AND vt.type = 'CRIMINAL'
      AND w.cnic IS NOT NULL AND w.cnic != ''
  `);
  console.log(`Tasks without CPLC review (COMPLETED CRIMINAL): ${tasksWithoutReview.length}\n`);

  // 3. Load old DB employments with CPLC status
  console.log('Loading old DB employments...');
  const { rows: oldEmps } = await oldDb.query(`
    SELECT e.id AS emp_id, w.cnic, e.cplc_verification_status,
           e.verification_timestamp, e.registration_timestamp
    FROM user_worker_employment e
    JOIN worker w ON w.id = e.worker_id
    WHERE e.cplc_verification_status IS NOT NULL
      AND w.cnic IS NOT NULL AND w.cnic != ''
  `);
  console.log(`Old employments with CPLC status: ${oldEmps.length}`);

  // Build CNIC → best old employment (most recent with CPLC verdict)
  const oldByCnic = new Map();
  for (const e of oldEmps) {
    const raw = decryptCnic(e.cnic);
    if (!raw) continue;
    const nc = normalize(raw);
    if (!nc || nc.length < 10) continue;
    const existing = oldByCnic.get(nc);
    if (!existing || e.emp_id > existing.emp_id) {
      oldByCnic.set(nc, e);
    }
  }
  console.log(`Old unique CNICs with CPLC status: ${oldByCnic.size}\n`);

  // 4. Match and prepare inserts
  const inserts = [];
  let noMatch = 0;
  let noVerdict = 0;

  for (const task of tasksWithoutReview) {
    const nc = normalize(task.cnic);
    if (!nc) { noMatch++; continue; }
    const old = oldByCnic.get(nc);
    if (!old) { noMatch++; continue; }
    const verdict = mapCplcVerdict(old.cplc_verification_status);
    if (!verdict) { noVerdict++; continue; }

    const createdAt = old.verification_timestamp || old.registration_timestamp || new Date();
    inserts.push([
      createId(),
      task.task_id,
      cplcReviewerId,
      verdict,
      `Migrated from legacy employment #${old.emp_id}`,
      createdAt,
      createdAt,
    ]);
  }

  console.log('=== SUMMARY ===');
  console.log(`Tasks without CPLC review: ${tasksWithoutReview.length}`);
  console.log(`Matched with CPLC verdict: ${inserts.length}`);
  console.log(`No CNIC match in old DB: ${noMatch}`);
  console.log(`Match but no CPLC verdict: ${noVerdict}`);

  // Verdict breakdown
  const verdictCounts = {};
  for (const i of inserts) {
    verdictCounts[i[3]] = (verdictCounts[i[3]] || 0) + 1;
  }
  console.log('\nBy verdict:');
  for (const [v, c] of Object.entries(verdictCounts)) console.log(`  ${v}: ${c}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes. Run with --apply to execute.');
    await newDb.end(); await oldDb.end();
    return;
  }

  // 5. Insert
  console.log(`\nInserting ${inserts.length} CPLC reviews...`);
  const CHUNK = 500;
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const chunk = inserts.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, idx) => {
      const b = idx * 7;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`;
    }).join(',');
    await newDb.query(`
      INSERT INTO cplc_verification_reviews
        (id, "taskId", "reviewerId", verdict, notes, "createdAt", "updatedAt")
      VALUES ${placeholders}
      ON CONFLICT ("taskId") DO NOTHING
    `, chunk.flat());
    if ((i + CHUNK) % 5000 === 0 || i + CHUNK >= inserts.length) {
      console.log(`  Inserted: ${Math.min(i + CHUNK, inserts.length)} / ${inserts.length}`);
    }
  }

  // Verify
  const { rows: [after] } = await newDb.query(`
    SELECT COUNT(*)::int AS cnt FROM cplc_verification_reviews
  `);
  console.log(`\nTotal CPLC reviews now: ${after.cnt}`);

  await newDb.end(); await oldDb.end();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
