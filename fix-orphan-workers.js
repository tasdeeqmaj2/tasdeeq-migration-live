/**
 * Fix orphan workers: create missing verification tasks + criminal forms + CPLC reviews
 * for workers that exist in new DB but have no verification tasks.
 *
 * Matches orphan workers by CNIC to old DB employments and recreates the full chain:
 *   verification_task → criminal_verification_form → cplc_verification_review
 *
 * Usage:
 *   node fix-orphan-workers.js                          # local dry run
 *   node fix-orphan-workers.js --apply                  # local apply
 *   DATABASE_URL="<new>" OLD_DATABASE_URL="<old>" node fix-orphan-workers.js --prod --dry-run
 *   DATABASE_URL="<new>" OLD_DATABASE_URL="<old>" node fix-orphan-workers.js --prod --apply
 */

const { Client } = require('pg');
const crypto = require('crypto');

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

if (!NEW_URL || !OLD_URL) {
  console.error('Set DATABASE_URL and OLD_DATABASE_URL');
  process.exit(1);
}

const { decryptLegacy } = require('./utils/decrypt');

// ----- helpers -----

function createId() {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(12).toString('hex');
  return 'cm' + ts + rnd.slice(0, 23);
}

function decryptCnic(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  return decryptLegacy(s);
}

function normalize(cnic) {
  if (!cnic) return null;
  return cnic.replace(/[-\s]/g, '');
}

function normFile(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  return s;
}

function strOr(val, fallback) {
  const s = val != null ? String(val).trim() : '';
  return s || fallback;
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

function mapFormResult(cplc, sindh, islamabad) {
  const values = [cplc, sindh, islamabad]
    .map(v => v ? String(v).trim().toLowerCase() : null)
    .filter(Boolean);
  if (values.length === 0) return null;
  if (values.some(s => /reject|fail|deni|criminal/.test(s))) return 'CRIMINAL_RECORD';
  if (values.some(s => /approv|verif|complet|success|clear|pass|skip/.test(s))) return 'CLEARED';
  return null;
}

function mapCplcVerdict(status) {
  if (!status) return null;
  const s = String(status).trim().toLowerCase();
  if (!s) return null;
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

  // 1. Find the system user (used as createdById for migrated tasks)
  const { rows: [systemUser] } = await newDb.query(`
    SELECT "createdById", COUNT(*)::int AS cnt
    FROM verification_tasks
    GROUP BY "createdById"
    ORDER BY cnt DESC
    LIMIT 1
  `);
  const systemUserId = systemUser.createdById;
  console.log(`System user (most common createdById): ${systemUserId} (${systemUser.cnt} tasks)\n`);

  // 2. Load city/province lookups
  const { rows: cities } = await newDb.query('SELECT id, name, "provinceId" FROM cities');
  const cityByName = new Map();
  const provinceIdByCityId = new Map();
  const cityIds = new Set();
  let fallbackCityId = null, fallbackProvinceId = null;
  for (const c of cities) {
    cityIds.add(c.id);
    cityByName.set(c.name.trim().toLowerCase().replace(/[-\s]+/g, ' '), c.id);
    provinceIdByCityId.set(c.id, c.provinceId);
    if (!fallbackCityId) { fallbackCityId = c.id; fallbackProvinceId = c.provinceId; }
  }

  // 3. Load orphan workers from new DB
  console.log('Loading orphan workers from new DB...');
  const { rows: orphans } = await newDb.query(`
    SELECT w.id, w.cnic, w.name, w."companyId"
    FROM workers w
    LEFT JOIN verification_tasks vt ON vt."workerId" = w.id
    WHERE vt.id IS NULL AND w.cnic IS NOT NULL AND w.cnic != ''
  `);
  console.log(`Orphan workers: ${orphans.length}\n`);

  // Build CNIC → orphan worker(s)
  const orphanByCnic = new Map();
  for (const w of orphans) {
    const nc = normalize(w.cnic);
    if (!nc) continue;
    if (!orphanByCnic.has(nc)) orphanByCnic.set(nc, []);
    orphanByCnic.get(nc).push(w);
  }

  // 4. Load old DB employments
  console.log('Loading old DB employments...');
  const { rows: oldEmps } = await oldDb.query(`
    SELECT e.id AS emp_id, e.full_name, e.father_name, e.address,
           e.city AS employment_city, e.user_id,
           e.cplc_verification_status, e.sindh_police_verification_status,
           e.islamabad_police_verification_status,
           e.verification_timestamp, e.registration_timestamp,
           w.cnic, w.date_of_birth,
           w.cnic_front_picture_link AS worker_cnic_front,
           w.cnic_back_picture_link AS worker_cnic_back,
           w.picture_link AS worker_face_photo,
           w.city_id AS worker_city_id, w.province_id AS worker_province_id
    FROM user_worker_employment e
    JOIN worker w ON w.id = e.worker_id
    WHERE w.cnic IS NOT NULL AND w.cnic != ''
  `);
  console.log(`Old employments: ${oldEmps.length}`);

  // Build CNIC → old employments
  const oldByCnic = new Map();
  for (const e of oldEmps) {
    const raw = decryptCnic(e.cnic);
    if (!raw) continue;
    const nc = normalize(raw);
    if (!nc || nc.length < 10) continue;
    if (!oldByCnic.has(nc)) oldByCnic.set(nc, []);
    oldByCnic.get(nc).push(e);
  }

  // 5. Load old employment documents
  console.log('Loading old DB employment documents...');
  const { rows: oldDocs } = await oldDb.query(`
    SELECT DISTINCT ON (d.user_worker_employment_id)
           d.user_worker_employment_id AS emp_id,
           d.cnic_front_picture_link, d.cnic_back_picture_link, d.picture_link
    FROM user_worker_employment_document d
    WHERE d.is_active IS DISTINCT FROM false
    ORDER BY d.user_worker_employment_id, d.id DESC
  `);
  const docMap = new Map();
  for (const d of oldDocs) docMap.set(Number(d.emp_id), d);
  console.log(`Old documents: ${oldDocs.length}\n`);

  // 6. Load existing CPLC reviewer (for CPLC reviews — use a system reviewer if available)
  const { rows: cplcUsers } = await newDb.query(`SELECT id FROM cplc_users LIMIT 1`);
  const cplcReviewerId = cplcUsers.length > 0 ? cplcUsers[0].id : null;
  console.log(`CPLC reviewer: ${cplcReviewerId || 'NONE — CPLC reviews will be skipped'}\n`);

  // 7. Match and prepare inserts
  let matched = 0;
  let noMatch = 0;
  let tasksToCreate = 0;
  let formsToCreate = 0;
  let cplcToCreate = 0;

  const taskInserts = [];   // { values: [...] }
  const formInserts = [];   // { values: [...] }
  const cplcInserts = [];   // { values: [...] }

  for (const [cnic, workers] of orphanByCnic) {
    const oldEmployments = oldByCnic.get(cnic);
    if (!oldEmployments || oldEmployments.length === 0) {
      noMatch += workers.length;
      continue;
    }

    // For each orphan worker, pick the best old employment to recreate from
    // If multiple old employments, use the most recent one (highest emp_id)
    for (const worker of workers) {
      const bestOld = oldEmployments.reduce((best, e) =>
        (!best || e.emp_id > best.emp_id) ? e : best, null);

      if (!bestOld) { noMatch++; continue; }
      matched++;

      const docs = docMap.get(Number(bestOld.emp_id));
      const now = new Date();
      const createdAt = bestOld.verification_timestamp || bestOld.registration_timestamp || now;

      // --- Verification Task ---
      const taskId = createId();
      const status = mapStatus(
        bestOld.cplc_verification_status,
        bestOld.sindh_police_verification_status,
        bestOld.islamabad_police_verification_status
      );

      taskInserts.push([
        taskId,
        worker.id,         // workerId
        worker.companyId,   // companyId
        systemUserId,       // createdById
        'CRIMINAL',         // type
        status,             // status
        'CORPORATE',        // filledBy
        createdAt,          // createdAt
        createdAt,          // updatedAt
      ]);
      tasksToCreate++;

      // --- Criminal Verification Form ---
      const formId = createId();
      const fullName = strOr(bestOld.full_name, worker.name || 'Unknown');
      const fatherName = strOr(bestOld.father_name, 'Unknown');
      const dob = bestOld.date_of_birth || new Date('1900-01-01');
      const cnicNumber = worker.cnic; // already in new format
      const address = strOr(bestOld.address, 'Unknown');

      // Resolve city/province
      let cityId = null, provinceId = null;
      if (bestOld.worker_city_id && cityIds.has(bestOld.worker_city_id)) {
        cityId = bestOld.worker_city_id;
        provinceId = bestOld.worker_province_id && provinceIdByCityId.has(bestOld.worker_province_id)
          ? bestOld.worker_province_id
          : provinceIdByCityId.get(cityId) || null;
      }
      if (!cityId && bestOld.employment_city) {
        const lookupName = bestOld.employment_city.trim().toLowerCase().replace(/[-\s]+/g, ' ');
        const foundCityId = cityByName.get(lookupName);
        if (foundCityId) {
          cityId = foundCityId;
          provinceId = provinceIdByCityId.get(cityId) || null;
        }
      }
      if (!cityId) { cityId = fallbackCityId; provinceId = fallbackProvinceId; }

      // Result
      const result = mapFormResult(
        bestOld.cplc_verification_status,
        bestOld.sindh_police_verification_status,
        bestOld.islamabad_police_verification_status
      );
      const resultAt = result ? (bestOld.verification_timestamp || createdAt) : null;
      const resultNotes = result ? `Migrated from legacy employment #${bestOld.emp_id}` : null;

      // Images
      const cnicFront = normFile(docs?.cnic_front_picture_link) || normFile(bestOld.worker_cnic_front);
      const cnicBack = normFile(docs?.cnic_back_picture_link) || normFile(bestOld.worker_cnic_back);
      const facePhoto = normFile(docs?.picture_link) || normFile(bestOld.worker_face_photo);

      formInserts.push([
        formId,
        taskId,
        fullName,
        fatherName,
        dob,
        cnicNumber,
        address,
        cityId,
        provinceId,
        cnicFront,
        cnicBack,
        facePhoto,
        result,
        resultNotes,
        resultAt,
        createdAt,
        createdAt,
      ]);
      formsToCreate++;

      // --- CPLC Review ---
      if (cplcReviewerId) {
        const cplcVerdict = mapCplcVerdict(bestOld.cplc_verification_status);
        if (cplcVerdict) {
          const reviewId = createId();
          cplcInserts.push([
            reviewId,
            taskId,
            cplcReviewerId,
            cplcVerdict,
            `Migrated from legacy employment #${bestOld.emp_id}`,
            createdAt,
            createdAt,
          ]);
          cplcToCreate++;
        }
      }
    }
  }

  // Summary
  console.log('=== SUMMARY ===');
  console.log(`Orphan workers matched to old DB: ${matched}`);
  console.log(`No match in old DB: ${noMatch}`);
  console.log(`Tasks to create: ${tasksToCreate}`);
  console.log(`Forms to create: ${formsToCreate}`);
  console.log(`CPLC reviews to create: ${cplcToCreate}`);

  // Status breakdown
  const statusCounts = {};
  for (const t of taskInserts) {
    const s = t[5];
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  console.log('\nTasks by status:');
  for (const [s, c] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${c}`);
  }

  // Result breakdown
  const resultCounts = {};
  for (const f of formInserts) {
    const r = f[12] || 'NULL';
    resultCounts[r] = (resultCounts[r] || 0) + 1;
  }
  console.log('\nForms by result:');
  for (const [r, c] of Object.entries(resultCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r}: ${c}`);
  }

  // Samples
  console.log('\nSample tasks (first 10):');
  for (const t of taskInserts.slice(0, 10)) {
    const f = formInserts.find(f => f[1] === t[0]);
    console.log(`  ${f?.[2]} (${f?.[5]}) → ${t[5]} | result: ${f?.[12] || '-'} | images: front=${f?.[9] ? 'YES' : 'NO'} back=${f?.[10] ? 'YES' : 'NO'} photo=${f?.[11] ? 'YES' : 'NO'}`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes applied. Run with --apply to execute.');
    await newDb.end();
    await oldDb.end();
    console.log('Done.');
    return;
  }

  // 8. Apply inserts in batches
  console.log(`\nApplying ${tasksToCreate} tasks...`);
  const CHUNK = 500;

  for (let i = 0; i < taskInserts.length; i += CHUNK) {
    const chunk = taskInserts.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, idx) => {
      const base = idx * 9;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`;
    }).join(',');
    const values = chunk.flat();
    await newDb.query(`
      INSERT INTO verification_tasks
        (id, "workerId", "companyId", "createdById", type, status, "filledBy", "createdAt", "updatedAt")
      VALUES ${placeholders}
      ON CONFLICT (id) DO NOTHING
    `, values);
    if ((i + CHUNK) % 5000 === 0 || i + CHUNK >= taskInserts.length) {
      console.log(`  Tasks inserted: ${Math.min(i + CHUNK, taskInserts.length)} / ${taskInserts.length}`);
    }
  }

  console.log(`Applying ${formsToCreate} criminal forms...`);
  for (let i = 0; i < formInserts.length; i += CHUNK) {
    const chunk = formInserts.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, idx) => {
      const base = idx * 17;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+15},$${base+16},$${base+17})`;
    }).join(',');
    const values = chunk.flat();
    await newDb.query(`
      INSERT INTO criminal_verification_forms
        (id, "taskId", "fullName", "fatherName", "dateOfBirth", "cnicNumber",
         "currentAddress", "cityId", "provinceId", "cnicFrontKey", "cnicBackKey", "facePhotoKey",
         result, "resultNotes", "resultAt", "createdAt", "updatedAt")
      VALUES ${placeholders}
      ON CONFLICT ("taskId") DO NOTHING
    `, values);
    if ((i + CHUNK) % 5000 === 0 || i + CHUNK >= formInserts.length) {
      console.log(`  Forms inserted: ${Math.min(i + CHUNK, formInserts.length)} / ${formInserts.length}`);
    }
  }

  if (cplcInserts.length > 0) {
    console.log(`Applying ${cplcToCreate} CPLC reviews...`);
    for (let i = 0; i < cplcInserts.length; i += CHUNK) {
      const chunk = cplcInserts.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, idx) => {
        const base = idx * 7;
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`;
      }).join(',');
      const values = chunk.flat();
      await newDb.query(`
        INSERT INTO cplc_verification_reviews
          (id, "taskId", "reviewerId", verdict, notes, "createdAt", "updatedAt")
        VALUES ${placeholders}
        ON CONFLICT ("taskId") DO NOTHING
      `, values);
      if ((i + CHUNK) % 5000 === 0 || i + CHUNK >= cplcInserts.length) {
        console.log(`  CPLC reviews inserted: ${Math.min(i + CHUNK, cplcInserts.length)} / ${cplcInserts.length}`);
      }
    }
  }

  // 9. Verify
  const { rows: [after] } = await newDb.query(`
    SELECT COUNT(*)::int AS orphans FROM workers w
    LEFT JOIN verification_tasks vt ON vt."workerId" = w.id
    WHERE vt.id IS NULL
  `);
  console.log(`\nAfter fix — orphan workers remaining: ${after.orphans}`);

  const { rows: statusAfter } = await newDb.query(`
    SELECT status, COUNT(*)::int AS cnt FROM verification_tasks GROUP BY status ORDER BY cnt DESC
  `);
  console.log('Task status breakdown:');
  for (const r of statusAfter) console.log(`  ${r.status}: ${r.cnt}`);

  await newDb.end();
  await oldDb.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
