const { getOldDb } = require('../db/oldDb');
const { getNewDb } = require('../db/newDb');
const { section, warn, info } = require('../utils/logger');
const { formatCount } = require('../utils/progress');
const { loadMap } = require('../utils/maps');

async function countOld(query, params = []) {
  const result = await getOldDb().query(query, params);
  return Number(result.rows[0].count);
}

async function countNew(query, params = []) {
  const result = await getNewDb().query(query, params);
  return Number(result.rows[0].count);
}

async function validateMigration() {
  section('Validating Migration...');

  const companyMap = loadMap('companyMap.json');
  const userMap = loadMap('userMap.json');
  const workerMap = loadMap('workerMap.json');
  const documentMap = loadMap('documentMap.json');
  const taskMap = loadMap('verificationTaskMap.json');
  const formMap = loadMap('criminalFormMap.json');
  const cplcMap = loadMap('cplcReviewMap.json');
  const udvMap = loadMap('userDocumentVerificationMap.json');

  const oldCompanies = await countOld(`SELECT COUNT(*)::int AS count FROM organization`);
  const oldCorporateUsers = await countOld(
    `SELECT COUNT(*)::int AS count
     FROM "user" u
     INNER JOIN organization o ON o.user_id = u.id`
  );
  const oldActiveEmployments = await countOld(
    `SELECT COUNT(*)::int AS count
     FROM user_worker_employment e
     INNER JOIN worker w ON w.id = e.worker_id
     WHERE e.is_active = true`
  );
  const oldDocsWithLinks = await countOld(
    `SELECT COUNT(*)::int AS count
     FROM user_worker_employment_document d
     INNER JOIN user_worker_employment e ON e.id = d.user_worker_employment_id
     WHERE e.is_active = true
       AND (d.is_active IS DISTINCT FROM false)
       AND (
         (d.cnic_front_picture_link IS NOT NULL AND btrim(d.cnic_front_picture_link) <> '')
         OR (d.cnic_back_picture_link IS NOT NULL AND btrim(d.cnic_back_picture_link) <> '')
         OR (d.picture_link IS NOT NULL AND btrim(d.picture_link) <> '')
       )`
  );
  const oldUdvActive = await countOld(
    `SELECT COUNT(*)::int AS count
     FROM user_document_verification udv
     WHERE (udv.is_active IS DISTINCT FROM false)
       AND udv.document_link IS NOT NULL
       AND btrim(udv.document_link) <> ''`
  );
  // Expected document rows ≈ sum of non-null links for migrated employments only — approximate via map size
  const oldVerificationCandidates = await countOld(
    `SELECT COUNT(*)::int AS count
     FROM user_worker_employment e
     WHERE e.is_active = true
       AND (
         e.cplc_verification_status IS NOT NULL
         OR e.sindh_police_verification_status IS NOT NULL
         OR e.islamabad_police_verification_status IS NOT NULL
       )`
  );
  const oldCplcReviews = await countOld(
    `SELECT COUNT(*)::int AS count
     FROM user_worker_employment e
     WHERE e.is_active = true
       AND e.cplc_verification_status IS NOT NULL
       AND lower(btrim(e.cplc_verification_status)) IN (
         'approved', 'rejected', 'skipped', 'verified', 'completed'
       )`
  );

  const newCompanies = await countNew(`SELECT COUNT(*)::int AS count FROM companies`);
  const newCorporateUsers = await countNew(
    `SELECT COUNT(*)::int AS count FROM corporate_users`
  );
  const newWorkers = await countNew(`SELECT COUNT(*)::int AS count FROM workers`);
  const newDocuments = await countNew(
    `SELECT COUNT(*)::int AS count FROM worker_documents`
  );
  const newVerificationTasks = await countNew(
    `SELECT COUNT(*)::int AS count FROM verification_tasks WHERE type = 'CRIMINAL'`
  );
  const newCriminalForms = await countNew(
    `SELECT COUNT(*)::int AS count FROM criminal_verification_forms`
  );
  const newCplcReviews = await countNew(
    `SELECT COUNT(*)::int AS count FROM cplc_verification_reviews`
  );

  const checks = [
    {
      label: 'Companies (orgs + household employers)',
      old: oldCompanies,
      new: newCompanies,
      mapped: Object.keys(companyMap).length,
      note: 'new/mapped can exceed old orgs when household employers get synthetic companies',
    },
    {
      label: 'Corporate Users',
      old: oldCorporateUsers,
      new: newCorporateUsers,
      mapped: Object.keys(userMap).length,
      note: 'includes household employers with synthetic companies',
    },
    {
      label: 'Workers (active employments)',
      old: oldActiveEmployments,
      new: newWorkers,
      mapped: Object.keys(workerMap).length,
      critical: true,
    },
    {
      label: 'Documents (source rows with links)',
      old: oldDocsWithLinks,
      new: newDocuments,
      mapped: Object.keys(documentMap).length,
      note: 'new count can exceed old when one row expands to multiple files + worker-table/UDV fallbacks',
    },
    {
      label: 'User Document Verification (active)',
      old: oldUdvActive,
      new: Object.keys(udvMap).filter((k) => !k.includes(':')).length,
      mapped: Object.keys(udvMap).length,
      note: 'mapped to worker_documents via CNIC match; unmatched logged',
    },
    {
      label: 'Verification Tasks (CRIMINAL)',
      old: oldVerificationCandidates,
      new: newVerificationTasks,
      mapped: Object.keys(taskMap).length,
    },
    {
      label: 'Criminal Verification Forms',
      old: Object.keys(taskMap).length,
      new: newCriminalForms,
      mapped: Object.keys(formMap).length,
      note: 'forms are 1:1 with migrated verification tasks',
    },
    {
      label: 'CPLC Reviews',
      old: oldCplcReviews,
      new: newCplcReviews,
      mapped: Object.keys(cplcMap).length,
      note: 'only employments with decisive CPLC status',
    },
  ];

  let workerMismatch = false;

  for (const check of checks) {
    info(
      `${check.label}: old=${formatCount(check.old)}  new=${formatCount(check.new)}  mapped=${formatCount(check.mapped)}`
    );
    if (check.note) {
      info(`  (${check.note})`);
    }

    if (check.critical && check.old !== check.new) {
      warn(
        `Mismatch: Old Active Employments (${formatCount(check.old)}) != New Workers (${formatCount(check.new)})`
      );
      workerMismatch = true;
    }
  }

  // Explicit plan check
  if (oldActiveEmployments !== newWorkers) {
    warn(
      `Old Active Employments (${formatCount(oldActiveEmployments)}) == New Workers (${formatCount(newWorkers)}) ? NO`
    );
    workerMismatch = true;
  } else {
    info(
      `Old Active Employments (${formatCount(oldActiveEmployments)}) == New Workers (${formatCount(newWorkers)}) ? YES`
    );
  }

  return {
    ok: !workerMismatch,
    oldActiveEmployments,
    newWorkers,
    checks,
  };
}

module.exports = { validateMigration };
