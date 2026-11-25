/**
 * Create verification_tasks for workers that don't have one.
 * Uses old DB employment verification statuses when available,
 * falls back to COMPLETED for encrypted-migration workers.
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { decryptIfEncrypted, looksEncrypted, isValidEmail } = require('./utils/decrypt');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
const NEW_DB_URL = process.env.NEW_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
const BATCH_SIZE = 2000;

function cuid() {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}

function mapStatus(cplc, sindh, islamabad) {
  const combined = [cplc, sindh, islamabad]
    .filter(s => s != null && String(s).trim())
    .map(s => String(s).toLowerCase())
    .join(' ');

  if (!combined) return 'PENDING';
  if (/verified|approved|completed|success|clear|passed/.test(combined)) return 'COMPLETED';
  if (/pending|in_progress|in-progress|processing|submitted|in progress/.test(combined)) return 'PENDING';
  if (/rejected|failed|denied|cancelled|canceled/.test(combined)) return 'CANCELLED';
  return 'DRAFT';
}

async function run() {
  const opts = (url) => ({ connectionString: url, ssl: SSL, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
  const oldDb = new Client(opts(OLD_DB_URL));
  const newDb = new Client(opts(NEW_DB_URL));
  await oldDb.connect();
  await newDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);

  // Step 1: Find workers without verification_tasks
  console.log('=== Step 1: Finding workers without verification_tasks ===\n');
  const { rows: missing } = await newDb.query(`
    SELECT w.id, w."companyId", w."createdById", w.cnic, w."createdAt"
    FROM workers w
    WHERE NOT EXISTS (SELECT 1 FROM verification_tasks vt WHERE vt."workerId" = w.id)
  `);
  console.log(`Workers missing verification_tasks: ${missing.length}\n`);

  if (missing.length === 0) {
    console.log('Nothing to do.');
    await oldDb.end(); await newDb.end();
    return;
  }

  // Step 2: Build old DB index by CNIC+userId for status lookup
  console.log('=== Step 2: Building old DB verification status index ===\n');

  // Build map: old user email -> old user id
  const { rows: oldUsers } = await oldDb.query(`SELECT id, email FROM "user" WHERE email IS NOT NULL AND email != ''`);

  // Build map: new companyId -> old userId (via email matching)
  const { rows: newUsers } = await newDb.query(`
    SELECT u.email, cu."companyId"
    FROM users u JOIN corporate_users cu ON cu."userId" = u.id
    WHERE u.email IS NOT NULL
  `);
  const companyToEmails = {};
  for (const nu of newUsers) {
    if (!companyToEmails[nu.companyId]) companyToEmails[nu.companyId] = [];
    companyToEmails[nu.companyId].push(nu.email.toLowerCase());
  }

  const emailToOldId = {};
  for (const ou of oldUsers) {
    const email = looksEncrypted(ou.email) ? decryptIfEncrypted(ou.email) : ou.email;
    if (email && isValidEmail(email)) emailToOldId[email.toLowerCase()] = ou.id;
  }

  // Build old employment index: cnic -> { status, timestamp } per old userId
  // We'll query in batches per company
  const companyOldUserMap = {};
  for (const [companyId, emails] of Object.entries(companyToEmails)) {
    for (const email of emails) {
      const oldId = emailToOldId[email];
      if (oldId) {
        if (!companyOldUserMap[companyId]) companyOldUserMap[companyId] = [];
        companyOldUserMap[companyId].push(oldId);
      }
    }
  }

  // Get system user
  const { rows: [admin] } = await newDb.query(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
  const systemUserId = admin?.id;

  // Step 3: Create verification_tasks
  console.log('=== Step 3: Creating verification_tasks ===\n');

  const tasksToInsert = [];
  let withStatus = 0, defaultStatus = 0;

  // Group missing workers by company for efficient old DB lookup
  const byCompany = {};
  for (const w of missing) {
    if (!byCompany[w.companyId]) byCompany[w.companyId] = [];
    byCompany[w.companyId].push(w);
  }

  let companiesProcessed = 0;
  const totalCompanies = Object.keys(byCompany).length;

  for (const [companyId, workers] of Object.entries(byCompany)) {
    companiesProcessed++;
    const oldUserIds = companyOldUserMap[companyId] || [];
    let statusMap = {};

    if (oldUserIds.length > 0) {
      const cnicList = workers.map(w => w.cnic);
      const { rows: emps } = await oldDb.query(`
        SELECT w.cnic,
          e.cplc_verification_status, e.sindh_police_verification_status,
          e.islamabad_police_verification_status, e.verification_timestamp,
          e.registration_timestamp
        FROM user_worker_employment e JOIN worker w ON w.id = e.worker_id
        WHERE e.user_id = ANY($1::bigint[]) AND e.is_active = true AND w.cnic = ANY($2::text[])
      `, [oldUserIds, cnicList]);

      for (const emp of emps) {
        const cnic = emp.cnic ? String(emp.cnic).replace(/[^0-9]/g, '') : '';
        statusMap[cnic] = {
          status: mapStatus(emp.cplc_verification_status, emp.sindh_police_verification_status, emp.islamabad_police_verification_status),
          createdAt: emp.verification_timestamp || emp.registration_timestamp,
        };
      }
    }

    for (const w of workers) {
      const old = statusMap[w.cnic];
      const status = old ? old.status : 'COMPLETED';
      const createdAt = old?.createdAt || w.createdAt || new Date();
      if (old) withStatus++; else defaultStatus++;

      tasksToInsert.push([
        cuid(), w.id, companyId, w.createdById || systemUserId,
        'CRIMINAL', status, null, null, null, null, null, null, null, null, null,
        createdAt, createdAt,
      ]);
    }

    if (companiesProcessed % 1000 === 0) console.log(`  Processed ${companiesProcessed}/${totalCompanies} companies...`);
  }

  console.log(`\nTasks to create: ${tasksToInsert.length}`);
  console.log(`  With old DB status: ${withStatus}`);
  console.log(`  Default COMPLETED: ${defaultStatus}\n`);

  if (!DRY_RUN && tasksToInsert.length > 0) {
    await newDb.query('BEGIN');
    try {
      const cols = ['id', '"workerId"', '"companyId"', '"createdById"', 'type', 'status',
        '"filledBy"', '"formLinkToken"', '"formLinkOtp"', '"formLinkOtpExpiry"',
        '"approvedById"', '"approvedAt"', '"assignedToId"', '"assignedAt"', '"invoiceId"',
        '"createdAt"', '"updatedAt"'];

      for (let i = 0; i < tasksToInsert.length; i += 500) {
        const chunk = tasksToInsert.slice(i, i + 500);
        const params = []; const tuples = []; let p = 1;
        for (const v of chunk) { tuples.push(`(${v.map(() => `$${p++}`).join(',')})`); params.push(...v); }
        await newDb.query(`INSERT INTO verification_tasks (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
        if (i % 5000 === 0) console.log(`  Inserted ${Math.min(i + 500, tasksToInsert.length)}/${tasksToInsert.length}...`);
      }

      await newDb.query('COMMIT');
      console.log(`\n✓ Committed. Inserted ${tasksToInsert.length} verification_tasks.`);
    } catch (err) {
      await newDb.query('ROLLBACK');
      console.error(`\n✗ ROLLBACK: ${err.message}\n${err.stack}`);
    }
  } else if (DRY_RUN) {
    console.log(`[DRY] Would insert ${tasksToInsert.length} verification_tasks`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Workers missing tasks: ${missing.length}`);
  console.log(`  Tasks created:         ${tasksToInsert.length}`);
  console.log(`  With old status:       ${withStatus}`);
  console.log(`  Default COMPLETED:     ${defaultStatus}`);

  await oldDb.end(); await newDb.end();
}

run().catch(e => { console.error(e); process.exit(1); });
