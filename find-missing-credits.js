/**
 * Find ALL old-system users with available_verification units who are
 * missing their credit in the new system.
 *
 * Cross-references old DB (user + user_available_verification)
 * with new DB (companies via userMap or email/phone match).
 *
 * Outputs a JSON fix list that apply-all-credit-fixes.js can consume.
 *
 * Usage:
 *   node find-missing-credits.js              # local (docker for new DB)
 *   node find-missing-credits.js --prod       # production (pg client for both DBs)
 */

require('dotenv').config();
const { Client } = require('pg');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { decryptIfEncrypted, isValidEmail, isValidPhone } = require('./utils/contactFields');

const PROD = process.argv.includes('--prod');
const OLD_DB_URL = process.env.OLD_DATABASE_URL;
const NEW_DB_URL = process.env.NEW_DATABASE_URL || process.env.DATABASE_URL;

let newDb; // pg Client for --prod mode

function newPsql(sql) {
  const escaped = sql.replace(/\n/g, ' ').replace(/"/g, '\\"');
  return execSync(
    `docker exec tasdeeq-postgres-1 psql -U postgres -d tasdeeq -t -A -F "||" -c "${escaped}"`,
    { encoding: 'utf8' }
  ).trim();
}

async function queryNewDb(sql) {
  if (PROD) {
    const { rows } = await newDb.query(sql);
    if (rows.length === 0) return '';
    return rows.map(r => Object.values(r).join('||')).join('\n');
  }
  return newPsql(sql);
}

async function main() {
  console.log(`${PROD ? '[PRODUCTION]' : '[LOCAL]'} mode\n`);

  if (PROD) {
    if (!NEW_DB_URL) { console.error('Set NEW_DATABASE_URL or DATABASE_URL in .env'); process.exit(1); }
    newDb = new Client({ connectionString: NEW_DB_URL });
    await newDb.connect();
    console.log('Connected to new DB (pg client)');
  }

  // 1. Load old DB users with units
  const oldDb = new Client({ connectionString: OLD_DB_URL });
  await oldDb.connect();
  console.log('Connected to old DB');

  const { rows: oldUsers } = await oldDb.query(`
    SELECT u.id, u.email, u.phone_number, u.name,
           COALESCE(uav.available_verification, 0) AS avail_units
    FROM public.user u
    LEFT JOIN user_available_verification uav ON uav.user_id = u.id AND uav.is_active = true
    WHERE COALESCE(uav.available_verification, 0) > 0
    ORDER BY avail_units DESC
  `);

  console.log(`Found ${oldUsers.length} old users with units\n`);
  await oldDb.end();

  // 2. Load userMap if exists (old_id -> new_user_id)
  let userMap = {};
  const mapPath = path.join(__dirname, 'maps', 'userMap.json');
  if (fs.existsSync(mapPath)) {
    userMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    console.log(`Loaded userMap with ${Object.keys(userMap).length} entries`);
  }

  // 3. For each old user, find their company in the new DB
  const missing = [];
  const matched = [];
  const notFound = [];

  for (const u of oldUsers) {
    const oldId = String(u.id);
    const units = Number(u.avail_units);
    const expectedCredit = units * 500;

    // Try to decrypt email/phone
    let email = null;
    let phone = null;
    try {
      const rawEmail = u.email ? String(u.email).trim() : null;
      if (rawEmail) {
        const decrypted = decryptIfEncrypted(rawEmail);
        if (isValidEmail(decrypted)) email = decrypted;
      }
    } catch {}
    try {
      const rawPhone = u.phone_number ? String(u.phone_number).trim() : null;
      if (rawPhone) {
        const decrypted = decryptIfEncrypted(rawPhone);
        if (isValidPhone(decrypted)) phone = decrypted;
      }
    } catch {}

    // Try to find in new DB
    let companyId = null;
    let companyName = null;
    let currentCredit = 0;

    // Method 1: userMap
    if (userMap[oldId]) {
      const newUserId = userMap[oldId];
      const row = newPsql(`
        SELECT c.id, c.name, COALESCE(c."creditLimit", 0)
        FROM companies c
        JOIN corporate_users cu ON cu."companyId" = c.id
        WHERE cu."userId" = '${newUserId}'
        LIMIT 1
      `);
      if (row) {
        const [cid, cname, ccredit] = row.split('||');
        companyId = cid;
        companyName = cname;
        currentCredit = Number(ccredit);
      }
    }

    // Method 2: email match
    if (!companyId && email) {
      const row = newPsql(`
        SELECT c.id, c.name, COALESCE(c."creditLimit", 0)
        FROM companies c
        JOIN corporate_users cu ON cu."companyId" = c.id
        JOIN users u ON u.id = cu."userId"
        WHERE u.email = '${email.replace(/'/g, "''")}'
        LIMIT 1
      `);
      if (row) {
        const [cid, cname, ccredit] = row.split('||');
        companyId = cid;
        companyName = cname;
        currentCredit = Number(ccredit);
      }
    }

    // Method 3: phone match
    if (!companyId && phone) {
      const row = newPsql(`
        SELECT c.id, c.name, COALESCE(c."creditLimit", 0)
        FROM companies c
        JOIN corporate_users cu ON cu."companyId" = c.id
        JOIN users u ON u.id = cu."userId"
        WHERE u.phone = '${phone}'
        LIMIT 1
      `);
      if (row) {
        const [cid, cname, ccredit] = row.split('||');
        companyId = cid;
        companyName = cname;
        currentCredit = Number(ccredit);
      }
    }

    if (!companyId) {
      notFound.push({
        oldId,
        name: u.name,
        email: u.email,
        phone: u.phone_number,
        decryptedEmail: email,
        decryptedPhone: phone,
        oldUnits: units,
      });
      continue;
    }

    if (currentCredit >= expectedCredit) {
      matched.push({ oldId, name: u.name, companyId, companyName, oldUnits: units, currentCredit });
      continue;
    }

    missing.push({
      companyId,
      oldUnits: units,
      newCreditLimit: expectedCredit,
      currentCreditLimit: currentCredit,
      oldUserId: oldId,
      name: companyName || u.name,
      email: email || u.email,
      phone: phone || u.phone_number,
    });
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Already correct: ${matched.length}`);
  console.log(`Need credit fix: ${missing.length}`);
  console.log(`Not found in new DB: ${notFound.length}`);

  if (missing.length) {
    console.log(`\n--- Need credit fix ---`);
    missing.forEach(m => console.log(`  ${m.name} | ${m.email} | units: ${m.oldUnits} | current: ${m.currentCreditLimit} | should be: ${m.newCreditLimit}`));

    const outPath = path.join(__dirname, 'fix_units_credit_v3.json');
    fs.writeFileSync(outPath, JSON.stringify(missing, null, 2));
    console.log(`\nSaved to ${outPath}`);
  }

  if (notFound.length) {
    console.log(`\n--- Not found in new DB (skipped during migration) ---`);
    notFound.forEach(n => console.log(`  oldId:${n.oldId} | ${n.name} | email:${n.decryptedEmail || n.email} | phone:${n.decryptedPhone || n.phone} | units:${n.oldUnits}`));

    const outPath2 = path.join(__dirname, 'not_found_users_with_units.json');
    fs.writeFileSync(outPath2, JSON.stringify(notFound, null, 2));
    console.log(`\nSaved to ${outPath2}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
