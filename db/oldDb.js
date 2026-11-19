const { Pool } = require('pg');

let pool = null;

function getOldSchema() {
  const schema = (process.env.OLD_SCHEMA || 'tasdeeq_prelive').trim() || 'tasdeeq_prelive';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(
      `Invalid OLD_SCHEMA "${schema}" — use letters, numbers, underscore only`
    );
  }
  return schema;
}

function getOldDb() {
  if (pool) return pool;

  const connectionString = process.env.OLD_DATABASE_URL;
  if (!connectionString) {
    throw new Error('OLD_DATABASE_URL is not set');
  }

  const schema = getOldSchema();

  pool = new Pool({
    connectionString,
    options: `-c search_path=${schema},public -c timezone=UTC`,
    ssl: { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    console.error('Unexpected old DB pool error:', err.message);
  });

  return pool;
}

async function closeOldDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getOldDb, closeOldDb, getOldSchema };
