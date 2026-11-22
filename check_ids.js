const { Client } = require('pg');
async function main() {
  const client = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', password: '12345678', database: 'tasdeeq' });
  await client.connect();
  const ids = ['cmuzp7qyr45ca3p5ju8rrsx7l', 'cmuzp7qypgloksi58a5bnaiok', 'cmuzp7qyp0lpgxgvztsdjdgaz'];
  for (const id of ids) {
    const { rows } = await client.query('SELECT id, name FROM companies WHERE id = $1', [id]);
    console.log(id, '->', rows.length ? rows[0].name : 'NOT FOUND');
  }
  const { rows } = await client.query('SELECT id FROM companies LIMIT 3');
  console.log('Sample DB IDs:', rows.map(r => r.id));
  const { rows: cnt } = await client.query('SELECT count(*) FROM companies');
  console.log('Total companies:', cnt[0].count);
  await client.end();
}
main().catch(console.error);
