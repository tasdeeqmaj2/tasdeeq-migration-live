/**
 * Fix encrypted-migration workers:
 * 1. Delete ALL 164k duplicate workers created by the encrypted migration
 * 2. For each encrypted old user, find the correct target company in new DB
 * 3. Insert only the workers that are MISSING from that company
 *
 * Target company priority:
 *   - Real email match (e.g. afohsfsl@gmail.com -> Air Force company) FIRST
 *   - Migrated account (migrated-390093@...) as fallback
 *
 * DRY RUN by default. Set DRY_RUN=false to execute.
 */
require('dotenv').config();
const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { decryptIfEncrypted, looksEncrypted, isValidEmail } = require('./utils/decrypt');
const { normalizeLegacyFileRef } = require('./utils/legacyFiles');

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SSL = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
const NEW_DB_URL = process.env.NEW_DATABASE_URL || 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
const BATCH_SIZE = 2000;

if (!OLD_DB_URL) { console.error('Set OLD_DATABASE_URL in .env'); process.exit(1); }

function cuid() {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}
function mapHiringArea(categoryId) {
  return Number(categoryId) === 1 ? 'HOUSEHOLD' : 'COMMERCIAL';
}
function mapDuration(wd) {
  if (!wd) return null;
  const d = String(wd).trim().toLowerCase();
  if (d.includes('full')) return 'FULL_TIME';
  if (d.includes('part')) return 'PART_TIME';
  return null;
}
function mapWorkerTypeId(id) { const n = Number(id); return (n >= 1 && n <= 20) ? n : null; }
function inferFileType(key) {
  if (!key) return 'application/octet-stream';
  const ext = path.extname(String(key).split('?')[0]).toLowerCase();
  return { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf' }[ext] || 'application/octet-stream';
}

async function run() {
  const opts = (url) => ({ connectionString: url, ssl: SSL, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
  const oldDb = new Client(opts(OLD_DB_URL));
  const newDb = new Client(opts(NEW_DB_URL));
  await oldDb.connect();
  await newDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);

  const mapPath = path.join(__dirname, 'mappings', 'encryptedWorkerMap.json');
  let allEncWorkerIds = [];
  if (fs.existsSync(mapPath)) {
    const encWorkerMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    allEncWorkerIds = Object.values(encWorkerMap);
    console.log(`Encrypted worker map: ${allEncWorkerIds.length} entries\n`);
  } else {
    console.log(`No encryptedWorkerMap.json found — skipping Step 1 (delete)\n`);
  }

  // ── Step 1: Delete ALL encrypted-migration workers ──
  if (allEncWorkerIds.length > 0) {
    console.log('=== Step 1: Deleting all encrypted-migration workers ===\n');

    if (!DRY_RUN) {
      await newDb.query('BEGIN');
      let docsDeleted = 0, workersDeleted = 0;
      for (let i = 0; i < allEncWorkerIds.length; i += BATCH_SIZE) {
        const batch = allEncWorkerIds.slice(i, i + BATCH_SIZE);
        const { rowCount: dc } = await newDb.query(`DELETE FROM worker_documents WHERE "workerId" = ANY($1::text[])`, [batch]);
        docsDeleted += dc;
        const { rowCount: wc } = await newDb.query(`DELETE FROM workers WHERE id = ANY($1::text[])`, [batch]);
        workersDeleted += wc;
        if (i % 20000 === 0) console.log(`  Deleted ${workersDeleted} workers, ${docsDeleted} docs so far...`);
      }
      await newDb.query('COMMIT');
      console.log(`Deleted ${workersDeleted} workers + ${docsDeleted} docs\n`);
    } else {
      console.log(`[DRY] Would delete ${allEncWorkerIds.length} workers + their docs\n`);
    }
  }

  // ── Step 2: Build target company mapping for encrypted users ──
  console.log('=== Step 2: Building target company mapping ===\n');

  // Fetch all old encrypted-email users
  const { rows: oldUsers } = await oldDb.query(`
    SELECT id, email, phone_number FROM "user" WHERE email IS NOT NULL AND email != ''
  `);

  const encUsers = []; // { oldId, decryptedEmail, phone }
  for (const u of oldUsers) {
    if (!looksEncrypted(u.email)) continue;
    encUsers.push({
      oldId: String(u.id),
      decryptedEmail: decryptIfEncrypted(u.email),
      phone: u.phone_number,
    });
  }
  console.log(`Encrypted users: ${encUsers.length}`);

  // Build new DB indexes
  const { rows: newUsers } = await newDb.query(`
    SELECT u.id, u.email, u.phone, cu."companyId"
    FROM users u LEFT JOIN corporate_users cu ON cu."userId" = u.id
  `);
  const { rows: companies } = await newDb.query(`SELECT id FROM companies`);
  const companyExists = new Set(companies.map(c => c.id));

  const emailIndex = {};   // email -> { userId, companyId }
  const phoneIndex = {};
  const migratedIndex = {}; // oldId -> { userId, companyId }

  for (const nu of newUsers) {
    if (nu.email && nu.companyId) {
      if (nu.email.startsWith('migrated-') && nu.email.endsWith('@consumer.tasdeeq.app')) {
        const oldId = nu.email.replace('migrated-', '').replace('@consumer.tasdeeq.app', '');
        migratedIndex[oldId] = { userId: nu.id, companyId: nu.companyId };
      } else if (!nu.email.endsWith('@migrated.invalid')) {
        emailIndex[nu.email.toLowerCase()] = { userId: nu.id, companyId: nu.companyId };
      }
    }
    if (nu.phone && nu.companyId) {
      phoneIndex[nu.phone] = { userId: nu.id, companyId: nu.companyId };
    }
  }

  // Match each encrypted user to their TARGET company
  // Priority: real email > phone > migrated account
  const targetMap = {}; // oldUserId -> { userId, companyId }
  let mEmail = 0, mPhone = 0, mMigrated = 0, mNone = 0;

  for (const eu of encUsers) {
    let target = null;

    // Priority 1: Real email match
    if (isValidEmail(eu.decryptedEmail)) {
      const found = emailIndex[eu.decryptedEmail.toLowerCase()];
      if (found && companyExists.has(found.companyId)) {
        target = found;
        mEmail++;
      }
    }

    // Priority 2: Phone match
    if (!target && eu.phone) {
      const decPhone = decryptIfEncrypted(eu.phone);
      for (const ph of new Set([eu.phone, decPhone, eu.phone.replace(/^0/, '+92'), decPhone?.replace(/^0/, '+92')].filter(Boolean))) {
        const found = phoneIndex[ph];
        if (found && companyExists.has(found.companyId)) {
          target = found;
          mPhone++;
          break;
        }
      }
    }

    // Priority 3: Migrated account (fallback)
    if (!target) {
      const found = migratedIndex[eu.oldId];
      if (found && companyExists.has(found.companyId)) {
        target = found;
        mMigrated++;
      }
    }

    if (target) {
      targetMap[eu.oldId] = target;
    } else {
      mNone++;
    }
  }

  console.log(`Matched: ${Object.keys(targetMap).length} (email: ${mEmail}, phone: ${mPhone}, migrated: ${mMigrated})`);
  console.log(`Not matched: ${mNone}\n`);

  // ── Step 3: Find missing workers and insert ──
  console.log('=== Step 3: Finding and inserting missing workers ===\n');

  const { rows: [admin] } = await newDb.query(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
  const systemUserId = admin?.id;

  // Load existing workers index per company
  console.log('Loading existing workers index...');
  const existingIndex = new Set();
  let offset = 0;
  while (true) {
    const { rows } = await newDb.query(`SELECT "companyId", cnic FROM workers ORDER BY id LIMIT 50000 OFFSET $1`, [offset]);
    for (const r of rows) existingIndex.add(`${r.companyId}:${r.cnic}`);
    if (rows.length < 50000) break;
    offset += 50000;
  }
  console.log(`Loaded ${existingIndex.size} existing companyId+cnic pairs\n`);

  const matchedOldIds = Object.keys(targetMap).map(Number).filter(n => !isNaN(n));
  let totalEmps = 0, skipped = 0, inserted = 0;
  const workersToInsert = [];
  const docsToInsert = [];
  const seenKeys = new Set();
  const newEncMap = {};

  for (let i = 0; i < matchedOldIds.length; i += BATCH_SIZE) {
    const batchIds = matchedOldIds.slice(i, i + BATCH_SIZE);

    const { rows: emps } = await oldDb.query(`
      SELECT e.id AS eid, e.user_id, e.full_name, e.work_duration,
        e.worker_category_id, e.worker_type_id, e.registration_timestamp,
        w.cnic, w.phone_number AS worker_phone,
        w.picture_link, w.cnic_front_picture_link, w.cnic_back_picture_link
      FROM user_worker_employment e JOIN worker w ON w.id = e.worker_id
      WHERE e.user_id = ANY($1::bigint[]) AND e.is_active = true
    `, [batchIds]);

    totalEmps += emps.length;

    for (const emp of emps) {
      const target = targetMap[String(emp.user_id)];
      if (!target) continue;

      const cnic = emp.cnic ? String(emp.cnic).replace(/[^0-9]/g, '') : '0000000000000';
      const key = `${target.companyId}:${cnic}`;

      if (existingIndex.has(key) || seenKeys.has(key)) {
        skipped++;
        continue;
      }
      seenKeys.add(key);

      const workerId = cuid();
      newEncMap[String(emp.eid)] = workerId;

      workersToInsert.push([
        workerId, target.companyId, target.userId,
        emp.full_name || 'Unknown', null, emp.worker_phone || null, cnic,
        mapWorkerTypeId(emp.worker_type_id), mapDuration(emp.work_duration),
        mapHiringArea(emp.worker_category_id),
        emp.registration_timestamp || new Date(), new Date(),
      ]);

      for (const { kind, key: fkey } of [
        { kind: 'cnic-front', key: normalizeLegacyFileRef(emp.cnic_front_picture_link) },
        { kind: 'cnic-back', key: normalizeLegacyFileRef(emp.cnic_back_picture_link) },
        { kind: 'photo', key: normalizeLegacyFileRef(emp.picture_link) },
      ]) {
        if (!fkey) continue;
        docsToInsert.push([cuid(), workerId, fkey, kind, inferFileType(fkey), systemUserId, new Date()]);
      }
    }

    if (i % 20000 === 0) console.log(`  Processed ${Math.min(i + BATCH_SIZE, matchedOldIds.length)}/${matchedOldIds.length}...`);
  }

  console.log(`\nTotal employments: ${totalEmps}`);
  console.log(`Already exist (skipped): ${skipped}`);
  console.log(`To insert: ${workersToInsert.length} workers, ${docsToInsert.length} docs\n`);

  if (!DRY_RUN && workersToInsert.length > 0) {
    await newDb.query('BEGIN');
    try {
      const wCols = ['id', '"companyId"', '"createdById"', 'name', 'email', 'mobile', 'cnic', '"workerTypeId"', 'duration', '"hiringArea"', '"createdAt"', '"updatedAt"'];
      for (let i = 0; i < workersToInsert.length; i += 500) {
        const chunk = workersToInsert.slice(i, i + 500);
        const params = []; const tuples = []; let p = 1;
        for (const v of chunk) { tuples.push(`(${v.map(() => `$${p++}`).join(',')})`); params.push(...v); }
        await newDb.query(`INSERT INTO workers (${wCols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
      }
      console.log(`Inserted ${workersToInsert.length} workers`);

      const dCols = ['id', '"workerId"', 'key', 'name', '"fileType"', '"uploadedById"', '"createdAt"'];
      for (let i = 0; i < docsToInsert.length; i += 500) {
        const chunk = docsToInsert.slice(i, i + 500);
        const params = []; const tuples = []; let p = 1;
        for (const v of chunk) { tuples.push(`(${v.map(() => `$${p++}`).join(',')})`); params.push(...v); }
        await newDb.query(`INSERT INTO worker_documents (${dCols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
      }
      console.log(`Inserted ${docsToInsert.length} docs`);

      await newDb.query('COMMIT');
      console.log('\n✓ Committed.');
    } catch (err) {
      await newDb.query('ROLLBACK');
      console.error(`\n✗ ROLLBACK: ${err.message}\n${err.stack}`);
      await oldDb.end(); await newDb.end();
      return;
    }
  } else if (DRY_RUN) {
    console.log(`[DRY] Would insert ${workersToInsert.length} workers + ${docsToInsert.length} docs`);
  }

  // Save new map
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    const tmp = `${mapPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(newEncMap), 'utf8');
    fs.renameSync(tmp, mapPath);
    console.log(`Saved encryptedWorkerMap: ${Object.keys(newEncMap).length} entries`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Enc workers deleted:    ${allEncWorkerIds.length}`);
  console.log(`  Encrypted users:        ${encUsers.length}`);
  console.log(`  Matched to company:     ${Object.keys(targetMap).length} (email:${mEmail} phone:${mPhone} migrated:${mMigrated})`);
  console.log(`  Total employments:      ${totalEmps}`);
  console.log(`  Already exist:          ${skipped}`);
  console.log(`  Workers inserted:       ${workersToInsert.length}`);
  console.log(`  Docs inserted:          ${docsToInsert.length}`);

  await oldDb.end(); await newDb.end();
}

run().catch(e => { console.error(e); process.exit(1); });
