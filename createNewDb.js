require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const newUrl = process.env.NEW_DATABASE_URL;
  const oldUrl = process.env.OLD_DATABASE_URL;
  if (!newUrl) throw new Error('NEW_DATABASE_URL is not set');
  if (!oldUrl) throw new Error('OLD_DATABASE_URL is not set (used as admin for CREATE DATABASE)');

  const target = new URL(newUrl);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  const dbUser = decodeURIComponent(target.username);
  const dbPass = decodeURIComponent(target.password);

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
    throw new Error(`Unsafe database name: ${dbName}`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbUser)) {
    throw new Error(`Unsafe database user: ${dbUser}`);
  }

  // Use postgres credentials from OLD_DATABASE_URL host to create DB
  const adminUrl = new URL(oldUrl);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  console.log(`Connected as admin to ${adminUrl.hostname}`);

  const exists = await admin.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [dbName]
  );

  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${dbName}`);
    console.log(`Created database: ${dbName}`);
  } else {
    console.log(`Database already exists: ${dbName}`);
  }

  const role = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [
    dbUser,
  ]);
  if (role.rowCount === 0) {
    await admin.query(
      `CREATE USER ${dbUser} WITH PASSWORD '${dbPass.replace(/'/g, "''")}'`
    );
    console.log(`Created role: ${dbUser}`);
  } else {
    console.log(`Role already exists: ${dbUser}`);
  }

  await admin.query(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${dbUser}`);
  await admin.query(`ALTER DATABASE ${dbName} OWNER TO ${dbUser}`);
  console.log(`Ownership of ${dbName} → ${dbUser}`);

  await admin.end();

  // Grant schema privileges inside the new DB
  const dbClient = new Client({ connectionString: newUrl });
  await dbClient.connect();
  await dbClient.query(`GRANT ALL ON SCHEMA public TO ${dbUser}`);
  await dbClient.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${dbUser}`);
  await dbClient.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${dbUser}`
  );
  await dbClient.end();

  console.log('OK — apply Prisma schema next, then: npm run migrate:fresh');
  console.log(
    '  cd ../../tasdeeq/apps/api && npx prisma migrate deploy'
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
