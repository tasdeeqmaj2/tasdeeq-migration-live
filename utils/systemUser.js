const { createId } = require('./batch');

const SYSTEM_EMAIL = 'migration@tasdeeq.local';
const SYSTEM_NAME = 'Migration System';

/**
 * Ensure the migration system user exists in the new DB.
 * Returns the user id for use as createdById / uploadedById.
 */
async function ensureSystemUser(newPool) {
  const existing = await newPool.query(
    `SELECT id FROM users WHERE email = $1 LIMIT 1`,
    [SYSTEM_EMAIL]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const id = createId();
  const now = new Date();

  await newPool.query(
    `INSERT INTO users (
       id, name, email, "emailVerified", phone, role, banned,
       "isSuperAdmin", "isActive", "createdAt", "updatedAt"
     ) VALUES (
       $1, $2, $3, true, NULL, 'user', false,
       false, true, $4, $4
     )
     ON CONFLICT (email) DO NOTHING`,
    [id, SYSTEM_NAME, SYSTEM_EMAIL, now]
  );

  const again = await newPool.query(
    `SELECT id FROM users WHERE email = $1 LIMIT 1`,
    [SYSTEM_EMAIL]
  );

  if (again.rows.length === 0) {
    throw new Error('Failed to create or load migration system user');
  }

  return again.rows[0].id;
}

module.exports = { ensureSystemUser, SYSTEM_EMAIL, SYSTEM_NAME };
