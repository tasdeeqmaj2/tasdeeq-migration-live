/**
 * Migrate workers, documents, and verification data for users whose emails
 * were encrypted in the old DB and therefore missed during the original migration.
 *
 * Steps:
 *  1. Fetch ALL old users, decrypt their emails
 *  2. Identify encrypted-email users and match them to new DB users/companies
 *  3. For matched users, find their workers via user_worker_employment
 *  4. Insert missing workers into new DB
 *  5. Insert worker documents (cnic front/back, photo)
 *  6. Report summary
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
const BATCH_SIZE = Number(process.env.MIGRATE_BATCH_SIZE) || 2000;

if (!OLD_DB_URL) { console.error('Set OLD_DATABASE_URL in .env'); process.exit(1); }

const MAPS_DIR = path.join(__dirname, 'mappings');
const REPORT_PATH = path.join(__dirname, 'encrypted_users_migration_report.json');

function cuid() {
  return 'c' + Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
}

function loadMap(name) {
  const file = path.join(MAPS_DIR, name);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function saveMap(name, data) {
  if (!fs.existsSync(MAPS_DIR)) fs.mkdirSync(MAPS_DIR, { recursive: true });
  const file = path.join(MAPS_DIR, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function mapHiringArea(categoryId) {
  return Number(categoryId) === 1 ? 'HOUSEHOLD' : 'COMMERCIAL';
}

function mapDuration(workDuration) {
  if (!workDuration) return null;
  const d = String(workDuration).trim().toLowerCase();
  if (d.includes('full')) return 'FULL_TIME';
  if (d.includes('part')) return 'PART_TIME';
  return null;
}

function mapWorkerTypeId(oldTypeId) {
  const id = Number(oldTypeId);
  if (id >= 1 && id <= 20) return id;
  return null;
}

function inferFileType(key) {
  if (!key) return 'application/octet-stream';
  const ext = path.extname(String(key).split('?')[0]).toLowerCase();
  switch (ext) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

async function bulkInsert(client, table, columns, rows, chunkSize = 500) {
  if (!rows.length) return 0;
  let inserted = 0;
  const colList = columns.join(', ');
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params = [];
    const tuples = [];
    let p = 1;
    for (const values of chunk) {
      const ph = values.map(() => `$${p++}`);
      tuples.push(`(${ph.join(', ')})`);
      params.push(...values);
    }
    await client.query(
      `INSERT INTO ${table} (${colList}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      params
    );
    inserted += chunk.length;
  }
  return inserted;
}

async function run() {
  const oldDb = new Client({ connectionString: OLD_DB_URL, ssl: SSL });
  const newDb = new Client({ connectionString: NEW_DB_URL, ssl: SSL });
  await oldDb.connect();
  await newDb.connect();

  console.log(`MODE: ${DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE'}\n`);

  // Load existing maps
  const userMap = loadMap('userMap.json');
  const workerMap = loadMap('workerMap.json') || {};
  let encWorkerMap = loadMap('encryptedWorkerMap.json');

  // Validate encWorkerMap — remove entries pointing to workers that no longer exist
  const encWorkerIds = Object.values(encWorkerMap);
  if (encWorkerIds.length > 0) {
    console.log(`Validating encryptedWorkerMap (${encWorkerIds.length} entries)...`);
    const existingIds = new Set();
    for (let i = 0; i < encWorkerIds.length; i += 5000) {
      const batch = encWorkerIds.slice(i, i + 5000);
      const { rows } = await newDb.query(`SELECT id FROM workers WHERE id = ANY($1::text[])`, [batch]);
      for (const r of rows) existingIds.add(r.id);
    }
    const before = Object.keys(encWorkerMap).length;
    const cleaned = {};
    for (const [empId, wId] of Object.entries(encWorkerMap)) {
      if (existingIds.has(wId)) cleaned[empId] = wId;
    }
    encWorkerMap = cleaned;
    const removed = before - Object.keys(cleaned).length;
    if (removed > 0) {
      console.log(`Removed ${removed} stale entries (workers deleted), ${Object.keys(cleaned).length} valid\n`);
      if (!DRY_RUN) saveMap('encryptedWorkerMap.json', encWorkerMap);
    } else {
      console.log(`All ${before} entries valid\n`);
    }
  }

  // ── Step 1: Fetch all old users with encrypted emails ──
  console.log('=== Step 1: Fetching old users with encrypted emails ===\n');

  const { rows: oldUsers } = await oldDb.query(`
    SELECT id, email, phone_number, name, cnic
    FROM "user"
    WHERE email IS NOT NULL AND email != ''
  `);

  const encryptedUsers = [];
  const decryptedEmailIndex = {}; // decryptedEmail -> oldUser

  for (const u of oldUsers) {
    if (!looksEncrypted(u.email)) continue;
    const decrypted = decryptIfEncrypted(u.email);
    encryptedUsers.push({
      oldId: String(u.id),
      encryptedEmail: u.email,
      decryptedEmail: decrypted,
      phone: u.phone_number,
      name: u.name,
      cnic: u.cnic,
    });
    if (isValidEmail(decrypted)) {
      decryptedEmailIndex[decrypted.toLowerCase()] = String(u.id);
    }
  }

  console.log(`Total old users: ${oldUsers.length}`);
  console.log(`Encrypted-email users: ${encryptedUsers.length}`);
  console.log(`Successfully decrypted to valid email: ${Object.keys(decryptedEmailIndex).length}\n`);

  // Save decrypted email list for reference
  const emailListPath = path.join(__dirname, 'encrypted_users_decrypted.json');
  fs.writeFileSync(emailListPath, JSON.stringify(
    encryptedUsers.map(u => ({ oldId: u.oldId, decryptedEmail: u.decryptedEmail, phone: u.phone, name: u.name })),
    null, 2
  ));
  console.log(`Saved decrypted email list to ${emailListPath}\n`);

  // ── Step 2: Match encrypted-email users to new DB ──
  console.log('=== Step 2: Matching encrypted-email users to new DB ===\n');

  // Get super_admin for createdById
  const { rows: [admin] } = await newDb.query(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
  if (!admin) { console.error('No super_admin found in new DB'); return cleanup(); }
  const systemUserId = admin.id;

  // Build new DB email/phone index + company existence set
  const { rows: newUsers } = await newDb.query(`
    SELECT u.id, u.email, u.phone, cu."companyId", cu.role AS cu_role
    FROM users u
    LEFT JOIN corporate_users cu ON cu."userId" = u.id
  `);
  const { rows: existingCompanies } = await newDb.query(`SELECT id FROM companies`);
  const companyExists = new Set(existingCompanies.map(c => c.id));

  const newEmailIndex = {};  // email -> { userId, companyId }
  const newPhoneIndex = {};  // phone -> { userId, companyId }
  for (const nu of newUsers) {
    if (nu.email && !nu.email.endsWith('@migrated.invalid')) {
      newEmailIndex[nu.email.toLowerCase()] = { userId: nu.id, companyId: nu.companyId };
    }
    if (nu.phone) {
      newPhoneIndex[nu.phone] = { userId: nu.id, companyId: nu.companyId };
    }
  }

  let matchedByEmail = 0, matchedByPhone = 0, matchedByMap = 0, matchedByMigrated = 0, mapInvalid = 0, notMatched = 0;
  const matchedUsers = []; // { oldId, newUserId, newCompanyId, method }
  const unmatchedUsers = []; // encrypted users with no match in new DB

  // Build migrated-email index for priority matching
  const migratedEmailIndex = {};
  for (const nu of newUsers) {
    if (nu.email && nu.email.startsWith('migrated-') && nu.email.endsWith('@consumer.tasdeeq.app')) {
      const oldId = nu.email.replace('migrated-', '').replace('@consumer.tasdeeq.app', '');
      migratedEmailIndex[oldId] = { userId: nu.id, companyId: nu.companyId };
    }
  }
  console.log(`Migrated-email index: ${Object.keys(migratedEmailIndex).length} entries\n`);

  for (const eu of encryptedUsers) {
    let match = null;

    // Method 1: Prefer migrated-<oldId> account — the original migration already
    // placed workers there, so new workers should go to the same company
    const migrated = migratedEmailIndex[eu.oldId];
    if (migrated && migrated.companyId && companyExists.has(migrated.companyId)) {
      match = { newUserId: migrated.userId, newCompanyId: migrated.companyId, method: 'migrated' };
      matchedByMigrated++;
    }

    // Method 2: Already in userMap — but validate company exists in new DB
    if (!match && userMap[eu.oldId]) {
      const mapped = userMap[eu.oldId];
      const uid = typeof mapped === 'string' ? mapped : mapped.userId;
      const cid = typeof mapped === 'object' ? mapped.companyId : null;
      if (uid) {
        let companyId = cid;
        if (!companyId) {
          const { rows } = await newDb.query(
            `SELECT "companyId" FROM corporate_users WHERE "userId" = $1 LIMIT 1`, [uid]
          );
          if (rows.length) companyId = rows[0].companyId;
        }
        if (companyId && companyExists.has(companyId)) {
          match = { newUserId: uid, newCompanyId: companyId, method: 'userMap' };
          matchedByMap++;
        } else {
          mapInvalid++;
        }
      }
    }

    // Method 3: Decrypted email match
    if (!match && isValidEmail(eu.decryptedEmail)) {
      const found = newEmailIndex[eu.decryptedEmail.toLowerCase()];
      if (found && found.companyId && companyExists.has(found.companyId)) {
        match = { newUserId: found.userId, newCompanyId: found.companyId, method: 'email' };
        matchedByEmail++;
      }
    }

    // Method 4: Phone match (also try decrypted phone)
    if (!match) {
      const decryptedPhone = eu.phone ? decryptIfEncrypted(eu.phone) : null;
      const phoneCandidates = new Set();
      if (eu.phone) { phoneCandidates.add(eu.phone); phoneCandidates.add(eu.phone.replace(/^0/, '+92')); }
      if (decryptedPhone && decryptedPhone !== eu.phone) {
        phoneCandidates.add(decryptedPhone);
        phoneCandidates.add(decryptedPhone.replace(/^0/, '+92'));
      }
      for (const ph of phoneCandidates) {
        const found = newPhoneIndex[ph];
        if (found && found.companyId && companyExists.has(found.companyId)) {
          match = { newUserId: found.userId, newCompanyId: found.companyId, method: 'phone' };
          matchedByPhone++;
          break;
        }
      }
    }

    if (match) {
      matchedUsers.push({ oldId: eu.oldId, ...match });
    } else {
      unmatchedUsers.push(eu);
      notMatched++;
    }
  }

  console.log(`Matched: ${matchedUsers.length} (migrated: ${matchedByMigrated}, email: ${matchedByEmail}, phone: ${matchedByPhone}, userMap: ${matchedByMap})`);
  console.log(`UserMap pointed to missing company (fell through): ${mapInvalid}`);
  console.log(`Not matched: ${notMatched}\n`);

  // ── Step 2b: Create new users/companies for unmatched encrypted-email users ──
  console.log('=== Step 2b: Creating users & companies for unmatched users ===\n');

  let createdUsers = 0;
  const usersToCreate = [];   // { oldId, userId, companyId, corporateUserId, email, phone, name }

  for (const eu of unmatchedUsers) {
    const email = isValidEmail(eu.decryptedEmail)
      ? eu.decryptedEmail.toLowerCase()
      : `migrated-${eu.oldId}@consumer.tasdeeq.app`;
    const decryptedPhone = eu.phone ? decryptIfEncrypted(eu.phone) : null;
    const phone = decryptedPhone && /^\+?\d{10,15}$/.test(decryptedPhone.replace(/[\s-]/g, ''))
      ? decryptedPhone : null;
    const name = eu.name || 'Migrated User';

    const userId = cuid();
    const companyId = cuid();
    const corporateUserId = cuid();
    const now = new Date();

    usersToCreate.push({
      oldId: eu.oldId,
      userId, companyId, corporateUserId,
      userValues: [userId, email, name, phone, 'CONSUMER', true, true, false, false, now, now],
      companyValues: [companyId, name, email, phone, true, true, now],
      cuValues: [corporateUserId, userId, companyId, 'MEMBER', true, now],
    });
  }

  if (usersToCreate.length > 0) {
    if (!DRY_RUN) {
      // Insert users
      const userCols = ['id', 'email', 'name', 'phone', 'role', '"emailVerified"', '"isActive"', 'banned', '"isSuperAdmin"', '"createdAt"', '"updatedAt"'];
      const userRows = usersToCreate.map(u => u.userValues);
      const uInserted = await bulkInsert(newDb, 'users', userCols, userRows);
      console.log(`Created ${uInserted} users`);

      // Insert companies
      const companyCols = ['id', 'name', 'email', 'phone', '"isConsumer"', '"isActive"', '"updatedAt"'];
      const companyRows = usersToCreate.map(u => u.companyValues);
      const cInserted = await bulkInsert(newDb, 'companies', companyCols, companyRows);
      console.log(`Created ${cInserted} companies`);

      // Insert corporate_users links
      const cuCols = ['id', '"userId"', '"companyId"', 'role', '"isAdmin"', '"createdAt"'];
      const cuRows = usersToCreate.map(u => u.cuValues);
      const cuInserted = await bulkInsert(newDb, 'corporate_users', cuCols, cuRows);
      console.log(`Created ${cuInserted} corporate_users links`);

      createdUsers = uInserted;
    } else {
      console.log(`[DRY] Would create ${usersToCreate.length} users + companies + corporate_users links`);
      createdUsers = usersToCreate.length;
    }

    // Add newly created users to matchedUsers so their workers get migrated
    for (const u of usersToCreate) {
      matchedUsers.push({ oldId: u.oldId, newUserId: u.userId, newCompanyId: u.companyId, method: 'created' });
    }
  }

  console.log(`\nTotal matched after creation: ${matchedUsers.length}\n`);

  // ── Step 3: Fetch workers for matched users ──
  console.log('=== Step 3: Fetching workers for matched encrypted-email users ===\n');

  const matchedOldIds = matchedUsers.map(m => Number(m.oldId));
  const matchMap = {}; // oldUserId -> { newUserId, newCompanyId }
  for (const m of matchedUsers) {
    matchMap[m.oldId] = { newUserId: m.newUserId, newCompanyId: m.newCompanyId };
  }

  let totalEmployments = 0;
  let workersToInsert = [];
  let docsToInsert = [];
  let alreadyMigrated = 0;
  let skippedDuplicate = 0;

  // Build index of existing workers by companyId+cnic to prevent duplicates
  console.log('Loading existing workers index (companyId+cnic)...');
  const existingWorkerIndex = new Set();
  const EW_BATCH = 50000;
  let ewOffset = 0;
  while (true) {
    const { rows } = await newDb.query(
      `SELECT "companyId", cnic FROM workers ORDER BY id LIMIT $1 OFFSET $2`,
      [EW_BATCH, ewOffset]
    );
    for (const r of rows) {
      existingWorkerIndex.add(`${r.companyId}:${r.cnic}`);
    }
    if (rows.length < EW_BATCH) break;
    ewOffset += EW_BATCH;
  }
  console.log(`Loaded ${existingWorkerIndex.size} existing companyId+cnic pairs\n`);

  // Process in batches
  for (let i = 0; i < matchedOldIds.length; i += BATCH_SIZE) {
    const batchIds = matchedOldIds.slice(i, i + BATCH_SIZE);

    const { rows: employments } = await oldDb.query(`
      SELECT
        e.id AS employment_id,
        e.user_id,
        e.worker_id,
        e.full_name,
        e.father_name,
        e.address,
        e.city,
        e.work_duration,
        e.worker_category_id,
        e.worker_type_id,
        e.registration_timestamp,
        e.is_active,
        w.cnic,
        w.phone_number AS worker_phone,
        w.picture_link,
        w.cnic_front_picture_link,
        w.cnic_back_picture_link
      FROM user_worker_employment e
      JOIN worker w ON w.id = e.worker_id
      WHERE e.user_id = ANY($1::bigint[])
        AND e.is_active = true
    `, [batchIds]);

    totalEmployments += employments.length;

    for (const emp of employments) {
      const empId = String(emp.employment_id);

      // Skip if already migrated via map
      if (workerMap[empId] || encWorkerMap[empId]) {
        alreadyMigrated++;
        continue;
      }

      const userInfo = matchMap[String(emp.user_id)];
      if (!userInfo) continue;

      const cnic = emp.cnic ? String(emp.cnic).replace(/[^0-9]/g, '') : '0000000000000';

      // Skip if worker with same CNIC already exists in the target company
      const dedupKey = `${userInfo.newCompanyId}:${cnic}`;
      if (existingWorkerIndex.has(dedupKey)) {
        skippedDuplicate++;
        continue;
      }
      existingWorkerIndex.add(dedupKey);

      const workerId = cuid();

      workersToInsert.push({
        empId,
        values: [
          workerId,
          userInfo.newCompanyId,
          userInfo.newUserId,
          emp.full_name || 'Unknown',
          null, // email
          emp.worker_phone || null,
          cnic,
          mapWorkerTypeId(emp.worker_type_id),
          mapDuration(emp.work_duration),
          mapHiringArea(emp.worker_category_id),
          emp.registration_timestamp || new Date(),
          new Date(),
        ],
        workerId,
      });

      // Collect documents
      const imgFields = [
        { kind: 'cnic-front', key: normalizeLegacyFileRef(emp.cnic_front_picture_link) },
        { kind: 'cnic-back', key: normalizeLegacyFileRef(emp.cnic_back_picture_link) },
        { kind: 'photo', key: normalizeLegacyFileRef(emp.picture_link) },
      ];
      for (const img of imgFields) {
        if (!img.key) continue;
        docsToInsert.push({
          values: [
            cuid(),
            workerId,
            img.key,
            img.kind,
            inferFileType(img.key),
            systemUserId,
            new Date(),
          ],
        });
      }
    }
  }

  console.log(`Total employments found: ${totalEmployments}`);
  console.log(`Already migrated (skipped): ${alreadyMigrated}`);
  console.log(`Duplicate CNIC+company (skipped): ${skippedDuplicate}`);
  console.log(`Workers to insert: ${workersToInsert.length}`);
  console.log(`Documents to insert: ${docsToInsert.length}\n`);

  // ── Step 4: Insert into new DB ──
  if (workersToInsert.length === 0) {
    console.log('Nothing to migrate.\n');
    return cleanup();
  }

  console.log(`=== Step 4: ${DRY_RUN ? '[DRY] ' : ''}Inserting workers & documents ===\n`);

  if (!DRY_RUN) {
    await newDb.query('BEGIN');
    try {
      // Insert workers
      const workerCols = [
        'id', '"companyId"', '"createdById"', 'name', 'email', 'mobile',
        'cnic', '"workerTypeId"', 'duration', '"hiringArea"', '"createdAt"', '"updatedAt"'
      ];
      const workerRows = workersToInsert.map(w => w.values);
      const wInserted = await bulkInsert(newDb, 'workers', workerCols, workerRows);
      console.log(`Inserted ${wInserted} workers`);

      // Update map
      for (const w of workersToInsert) {
        encWorkerMap[w.empId] = w.workerId;
      }

      // Insert documents
      const docCols = ['id', '"workerId"', 'key', 'name', '"fileType"', '"uploadedById"', '"createdAt"'];
      const docRows = docsToInsert.map(d => d.values);
      const dInserted = await bulkInsert(newDb, 'worker_documents', docCols, docRows);
      console.log(`Inserted ${dInserted} worker documents`);

      await newDb.query('COMMIT');
      console.log('\n✓ Committed.');

      // Save map
      saveMap('encryptedWorkerMap.json', encWorkerMap);
      console.log(`Saved encryptedWorkerMap.json (${Object.keys(encWorkerMap).length} entries)`);
    } catch (err) {
      await newDb.query('ROLLBACK');
      console.error(`\n✗ ROLLBACK: ${err.message}`);
      console.error(err.stack);
      return cleanup();
    }
  } else {
    console.log(`[DRY] Would insert ${workersToInsert.length} workers`);
    console.log(`[DRY] Would insert ${docsToInsert.length} worker documents`);
  }

  // ── Summary ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Encrypted-email users: ${encryptedUsers.length}`);
  console.log(`  Matched to new DB:     ${matchedUsers.length}`);
  console.log(`    By migrated account: ${matchedByMigrated}`);
  console.log(`    By email:            ${matchedByEmail}`);
  console.log(`    By phone:            ${matchedByPhone}`);
  console.log(`    By userMap:          ${matchedByMap}`);
  console.log(`  UserMap → missing co:  ${mapInvalid}`);
  console.log(`  Not matched (created): ${notMatched}`);
  console.log(`  Users/companies created: ${createdUsers}`);
  console.log(`  Total employments:     ${totalEmployments}`);
  console.log(`  Already migrated:      ${alreadyMigrated}`);
  console.log(`  Duplicate CNIC+co:     ${skippedDuplicate}`);
  console.log(`  Workers inserted:      ${workersToInsert.length}`);
  console.log(`  Documents inserted:    ${docsToInsert.length}`);

  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    dryRun: DRY_RUN,
    encryptedUsers: encryptedUsers.length,
    matched: matchedUsers.length,
    matchedByEmail, matchedByPhone, matchedByMap, mapInvalid, notMatched, createdUsers,
    totalEmployments,
    alreadyMigrated, skippedDuplicate,
    workersInserted: workersToInsert.length,
    documentsInserted: docsToInsert.length,
    unmatchedSample: encryptedUsers
      .filter(eu => !matchMap[eu.oldId])
      .slice(0, 50)
      .map(eu => ({ oldId: eu.oldId, decryptedEmail: eu.decryptedEmail, phone: eu.phone })),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to ${REPORT_PATH}`);

  return cleanup();

  async function cleanup() {
    await oldDb.end();
    await newDb.end();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
