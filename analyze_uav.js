const fs = require('fs');

const uavLines = fs.readFileSync('C:/Users/92306/Downloads/user_available_verification.csv', 'utf8').split('\n');
const users = {};
for (let i = 1; i < uavLines.length; i++) {
  const cols = uavLines[i].replace(/"/g, '').split(',');
  if (!cols[1]) continue;
  const uid = cols[1].trim();
  const units = parseInt(cols[2]) || 0;
  if (units > 0) users[uid] = (users[uid] || 0) + units;
}

const values = Object.values(users).sort((a, b) => b - a);
console.log(`Users with units: ${values.length}`);
console.log(`Top 20:`);
values.slice(0, 20).forEach((v, i) => {
  const uid = Object.keys(users).find(k => users[k] === v);
  console.log(`  ${uid}: ${v.toLocaleString()} units (${(v * 500).toLocaleString()} PKR)`);
});

const brackets = [
  { label: '> 1M units', min: 1000000 },
  { label: '1K-1M', min: 1000, max: 1000000 },
  { label: '100-1K', min: 100, max: 1000 },
  { label: '10-100', min: 10, max: 100 },
  { label: '1-10', min: 1, max: 10 },
];
console.log('\nDistribution:');
for (const b of brackets) {
  const count = values.filter(v => v >= b.min && (!b.max || v < b.max)).length;
  console.log(`  ${b.label}: ${count} users`);
}
