// Prisma stores timestamp(3) columns as UTC wall time. Pin Node to UTC so legacy
// timestamp-without-time-zone values and new Date() round-trip unshifted.
process.env.TZ = 'UTC';

require('dotenv').config();

const { getOldDb, closeOldDb, getOldSchema } = require('./db/oldDb');
const { getNewDb, closeNewDb } = require('./db/newDb');
const { info, section, warn, flushErrors } = require('./utils/logger');
const { ensureSystemUser } = require('./utils/systemUser');
const { clearAllMaps } = require('./utils/maps');
const { resetTargetDb } = require('./resetTarget');
const { migrateCompanies } = require('./migrations/migrateCompanies');
const { migrateCorporateUsers } = require('./migrations/migrateCorporateUsers');
const { migrateWorkers } = require('./migrations/migrateWorkers');
const { migrateWorkerDocuments } = require('./migrations/migrateWorkerDocuments');
const {
  migrateUserDocumentVerification,
} = require('./migrations/migrateUserDocumentVerification');
const { migrateVerificationTasks } = require('./migrations/migrateVerificationTasks');
const {
  migrateCriminalVerificationForms,
} = require('./migrations/migrateCriminalVerificationForms');
const { validateMigration } = require('./migrations/validateMigration');

function redactUrl(url) {
  if (!url) return '(not set)';
  return String(url).replace(/:([^:@/]+)@/, ':***@');
}

function wantsFresh() {
  if (process.env.CLEAR_MAPS === '1' || process.env.FRESH === '1') return true;
  return process.argv.includes('--fresh');
}

async function main() {
  section('Tasdeeq Database Migration');

  info(`Old DB: ${redactUrl(process.env.OLD_DATABASE_URL)}`);
  info(`Old schema: ${getOldSchema()}`);
  info(`New DB: ${redactUrl(process.env.NEW_DATABASE_URL)}`);
  info('Connecting to databases...');

  const oldDb = getOldDb();
  const newDb = getNewDb();

  try {
    await oldDb.query('SELECT 1');
    info('Connected to old database');
  } catch (err) {
    throw new Error(
      `Old DB connection failed (${redactUrl(process.env.OLD_DATABASE_URL)}): ${err.message}`
    );
  }
  try {
    await newDb.query('SELECT 1');
    info('Connected to new database');
  } catch (err) {
    throw new Error(
      `New DB connection failed (${redactUrl(process.env.NEW_DATABASE_URL)}): ${err.message}`
    );
  }

  if (wantsFresh()) {
    const { cleared } = clearAllMaps();
    info(`Fresh run: cleared ${cleared} mapping file(s)`);
    warn('Fresh run: wiping migration tables in NEW database...');
    await resetTargetDb(newDb);
    info('NEW database migration tables cleared');
  }

  const systemUserId = await ensureSystemUser(newDb);
  info(`System user ready: ${systemUserId}`);

  // Order matters: companies → users → workers → docs → verification → forms
  await migrateCompanies();
  await migrateCorporateUsers();
  await migrateWorkers(systemUserId);
  await migrateWorkerDocuments(systemUserId);
  await migrateUserDocumentVerification(systemUserId);
  await migrateVerificationTasks(systemUserId);
  await migrateCriminalVerificationForms(systemUserId);

  const validation = await validateMigration();

  section('Migration Completed');
  flushErrors();
  if (!validation.ok) {
    warn(
      'Validation reported mismatches — see details above and logs/migration-errors.json'
    );
    process.exitCode = 1;
  } else {
    info('All critical checks passed');
  }
  info(
    'Next: run `npm run migrate:assets` in the background to upload legacy images to MinIO'
  );
}

main()
  .catch((err) => {
    console.error('\nMigration failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeOldDb(), closeNewDb()]);
  });
