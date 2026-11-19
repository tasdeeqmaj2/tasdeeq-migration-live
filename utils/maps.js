const fs = require('fs');
const path = require('path');

const MAPS_DIR = path.join(__dirname, '..', 'mappings');

const ALL_MAP_FILES = [
  'companyMap.json',
  'employerUserIndex.json',
  'companyEmailClaimMap.json',
  'userMap.json',
  'workerMap.json',
  'documentMap.json',
  'userDocumentVerificationMap.json',
  'verificationTaskMap.json',
  'criminalFormMap.json',
  'cplcReviewMap.json',
  'assetMap.json',
];

function mapPath(name) {
  return path.join(MAPS_DIR, name);
}

function loadMap(name) {
  const file = mapPath(name);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Compact JSON (no pretty-print) — critical for 100k+ map entries. */
function saveMap(name, data) {
  if (!fs.existsSync(MAPS_DIR)) {
    fs.mkdirSync(MAPS_DIR, { recursive: true });
  }
  const file = mapPath(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function clearAllMaps() {
  if (!fs.existsSync(MAPS_DIR)) {
    fs.mkdirSync(MAPS_DIR, { recursive: true });
    return { cleared: 0 };
  }

  let cleared = 0;
  for (const name of ALL_MAP_FILES) {
    const file = mapPath(name);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      cleared += 1;
    }
  }

  for (const entry of fs.readdirSync(MAPS_DIR)) {
    if (entry.endsWith('.tmp') || entry.endsWith('.json')) {
      try {
        fs.unlinkSync(path.join(MAPS_DIR, entry));
        if (!ALL_MAP_FILES.includes(entry)) cleared += 1;
      } catch {
        /* ignore */
      }
    }
  }

  return { cleared };
}

function buildEmployerUserIndex(companyMap, orgRows) {
  /** @type {Record<string, string>} oldEmployerUserId -> newCompanyId */
  const index = {};
  for (const row of orgRows) {
    if (row.user_id == null) continue;
    const companyId = companyMap[String(row.id)];
    if (companyId) {
      index[String(row.user_id)] = companyId;
    }
  }
  return index;
}

module.exports = {
  loadMap,
  saveMap,
  mapPath,
  clearAllMaps,
  buildEmployerUserIndex,
  MAPS_DIR,
  ALL_MAP_FILES,
};
