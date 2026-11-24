/**
 * Diagnose image keys on criminal_verification_forms:
 * - How many are proper S3 keys vs old legacy URLs
 * - Are the old URLs still accessible?
 *
 * Usage:
 *   DATABASE_URL="<prod>" node diagnose-image-keys.js --prod
 *   node diagnose-image-keys.js   # local
 */

const { Client } = require('pg');

const PROD = process.argv.includes('--prod');

let DB_URL;
if (PROD) {
  DB_URL = process.env.DATABASE_URL;
} else {
  DB_URL = 'postgresql://postgres:12345678@127.0.0.1:5433/tasdeeq';
}

if (!DB_URL) { console.error('Set DATABASE_URL'); process.exit(1); }

function classifyKey(val) {
  if (!val) return 'NULL';
  const s = String(val).trim();
  if (!s) return 'EMPTY';
  if (s.startsWith('http://') || s.startsWith('https://')) return 'LEGACY_URL';
  if (s.includes('download-asset')) return 'LEGACY_URL';
  if (s.match(/^[a-zA-Z0-9_/-]+\.(png|jpg|jpeg|webp|pdf)$/i)) return 'S3_KEY';
  if (s.startsWith('uploads/') || s.startsWith('cnic/') || s.startsWith('photos/') || s.startsWith('workers/')) return 'S3_KEY';
  return 'OTHER';
}

async function main() {
  const db = new Client({ connectionString: DB_URL, ssl: PROD ? { rejectUnauthorized: false } : false });
  await db.connect();
  console.log(`${PROD ? '[PROD]' : '[LOCAL]'} Connected.\n`);

  // 1. Get all non-null image keys
  const { rows: forms } = await db.query(`
    SELECT "cnicFrontKey", "cnicBackKey", "facePhotoKey"
    FROM criminal_verification_forms
    WHERE "cnicFrontKey" IS NOT NULL OR "cnicBackKey" IS NOT NULL OR "facePhotoKey" IS NOT NULL
  `);
  console.log(`Forms with at least one image key: ${forms.length}\n`);

  const stats = {
    front: { NULL: 0, EMPTY: 0, LEGACY_URL: 0, S3_KEY: 0, OTHER: 0 },
    back: { NULL: 0, EMPTY: 0, LEGACY_URL: 0, S3_KEY: 0, OTHER: 0 },
    photo: { NULL: 0, EMPTY: 0, LEGACY_URL: 0, S3_KEY: 0, OTHER: 0 },
  };

  const samples = { LEGACY_URL: [], S3_KEY: [], OTHER: [] };

  for (const f of forms) {
    const fc = classifyKey(f.cnicFrontKey);
    const bc = classifyKey(f.cnicBackKey);
    const pc = classifyKey(f.facePhotoKey);
    stats.front[fc]++;
    stats.back[bc]++;
    stats.photo[pc]++;

    // Collect samples
    for (const [key, type] of [[f.cnicFrontKey, fc], [f.cnicBackKey, bc], [f.facePhotoKey, pc]]) {
      if (type !== 'NULL' && type !== 'EMPTY' && samples[type] && samples[type].length < 5) {
        samples[type].push(key);
      }
    }
  }

  console.log('=== IMAGE KEY CLASSIFICATION ===');
  console.log('Type'.padEnd(15) + 'CNIC Front'.padStart(12) + 'CNIC Back'.padStart(12) + 'Face Photo'.padStart(12));
  console.log('-'.repeat(51));
  for (const type of ['NULL', 'EMPTY', 'LEGACY_URL', 'S3_KEY', 'OTHER']) {
    console.log(
      type.padEnd(15) +
      String(stats.front[type]).padStart(12) +
      String(stats.back[type]).padStart(12) +
      String(stats.photo[type]).padStart(12)
    );
  }

  console.log('\n=== SAMPLES ===');
  for (const [type, vals] of Object.entries(samples)) {
    if (vals.length > 0) {
      console.log(`\n${type}:`);
      for (const v of vals) console.log(`  ${String(v).slice(0, 120)}`);
    }
  }

  // 2. Test if old URLs are still accessible
  if (samples.LEGACY_URL.length > 0) {
    console.log('\n=== TESTING OLD URL ACCESSIBILITY ===');
    for (const url of samples.LEGACY_URL.slice(0, 3)) {
      try {
        const resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
        console.log(`  ${resp.status} ${resp.headers.get('content-type') || '-'} | ${url.slice(0, 80)}`);
      } catch (e) {
        console.log(`  FAILED (${e.message.slice(0, 40)}) | ${url.slice(0, 80)}`);
      }
    }
  }

  await db.end();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
