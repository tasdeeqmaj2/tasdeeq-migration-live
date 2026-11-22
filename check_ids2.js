const { Client } = require('pg');
async function main() {
  const client = new Client({ host: '127.0.0.1', port: 5433, user: 'postgres', password: '12345678', database: 'tasdeeq' });
  await client.connect();

  // Check ID prefix distribution
  const { rows } = await client.query(`SELECT left(id, 8) as prefix, count(*) FROM companies GROUP BY left(id, 8) ORDER BY count(*) DESC LIMIT 10`);
  console.log('Company ID prefixes:', rows);

  // Check if creditLimit exists
  const { rows: cl } = await client.query(`SELECT count(*) as total, count("creditLimit") as with_credit, count(CASE WHEN "creditLimit" > 0 THEN 1 END) as positive FROM companies`);
  console.log('Credit limits:', cl[0]);

  // Check if this is production data or fresh migration
  const { rows: users } = await client.query(`SELECT count(*) FROM users`);
  console.log('Total users:', users[0].count);

  const { rows: tasks } = await client.query(`SELECT count(*) FROM verification_tasks`);
  console.log('Total tasks:', tasks[0].count);

  await client.end();
}
main().catch(console.error);
