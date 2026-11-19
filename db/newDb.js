const { Pool } = require('pg');

let pool = null;

function getNewDb() {
  if (pool) return pool;

  const connectionString = process.env.NEW_DATABASE_URL;
  if (!connectionString) {
    throw new Error('NEW_DATABASE_URL is not set');
  }

  // timezone=UTC so SQL NOW() writes UTC wall time into timestamp columns
  pool = new Pool({
    connectionString,
    options: '-c timezone=UTC',
    ssl: { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    console.error('Unexpected new DB pool error:', err.message);
  });

  return pool;
}

async function closeNewDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getNewDb, closeNewDb };
