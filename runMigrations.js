process.env.TZ = 'UTC';
require('dotenv').config();

const { getNewDb, closeNewDb } = require('./db/newDb');
const { getOldDb, closeOldDb } = require('./db/oldDb');
const { migrateVerificationTasks } = require('./migrations/migrateVerificationTasks');
const { migrateCriminalVerificationForms } = require('./migrations/migrateCriminalVerificationForms');
const { flushErrors } = require('./utils/logger');

(async () => {
  const systemUserId = 'cmwnhyial8dec1ccd12b0c75a';
  await migrateVerificationTasks(systemUserId);
  await migrateCriminalVerificationForms(systemUserId);
  flushErrors();
  process.exit(0);
})().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
}).finally(async () => {
  await closeNewDb();
  await closeOldDb();
});
