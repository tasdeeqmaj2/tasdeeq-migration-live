/**
 * Wipe migrated business data from the NEW database so migrate:fresh
 * does not stack duplicate companies/workers/tasks.
 *
 * Keeps: super_admin / CPLC / migration system users, seed prices,
 * notification templates, bank details, job schedules.
 */
require('dotenv').config();
const { getNewDb, closeNewDb } = require('./db/newDb');
const { info, section, warn } = require('./utils/logger');
const { SYSTEM_EMAIL } = require('./utils/systemUser');

async function resetTargetDb(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Child → parent order via CASCADE
    await client.query(`
      TRUNCATE TABLE
        criminal_verification_forms,
        cplc_verification_reviews,
        invoice_items,
        invoices,
        verification_tasks,
        worker_documents,
        worker_notes,
        workers,
        company_verification_prices,
        corporate_users,
        companies,
        corporate_signup_pending,
        login_otps
      CASCADE
    `);

    // Remove migrated corporate login users (keep admins / CPLC / system)
    await client.query(
      `
      DELETE FROM users
      WHERE role = 'CORPORATE_USER'
         OR (
           email LIKE '%@migrated.invalid'
           AND email IS DISTINCT FROM $1
         )
      `,
      [SYSTEM_EMAIL]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  section('Reset NEW database (migration tables)');

  if (!process.env.NEW_DATABASE_URL) {
    throw new Error('NEW_DATABASE_URL is not set');
  }

  warn('This deletes companies, workers, docs, tasks, forms, corporate users from the NEW DB.');
  const pool = getNewDb();
  await pool.query('SELECT 1');
  await resetTargetDb(pool);

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM companies) AS companies,
      (SELECT COUNT(*)::int FROM workers) AS workers,
      (SELECT COUNT(*)::int FROM corporate_users) AS corporate_users,
      (SELECT COUNT(*)::int FROM verification_tasks) AS tasks,
      (SELECT COUNT(*)::int FROM criminal_verification_forms) AS forms,
      (SELECT COUNT(*)::int FROM worker_documents) AS documents
  `);
  info(`Target cleared: ${JSON.stringify(counts.rows[0])}`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeNewDb();
    });
}

module.exports = { resetTargetDb };
