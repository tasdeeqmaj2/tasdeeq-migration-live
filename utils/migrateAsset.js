const path = require('path');
const { logError } = require('./logger');
const { loadMap, saveMap } = require('./maps');
const { uploadToMinio } = require('./minioStorage');

const ASSET_MAP_NAME = 'assetMap.json';

const DEFAULT_LEGACY_BASE =
  process.env.LEGACY_ASSET_BASE_URL ||
  'https://tasdeequat.cee-solutions.com/tasdeeqPreLive';

/** In-memory cache loaded once per process; flushed via saveAssetMap(). */
let assetMapCache = null;

function getAssetMap() {
  if (!assetMapCache) assetMapCache = loadMap(ASSET_MAP_NAME);
  return assetMapCache;
}

function saveAssetMap() {
  if (assetMapCache) saveMap(ASSET_MAP_NAME, assetMapCache);
}

function getConcurrency() {
  const n = Number(process.env.ASSET_MIGRATE_CONCURRENCY || 5);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function mimeFromFileName(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * True when value is a legacy download-asset URL, absolute http(s) asset URL,
 * or a bare legacy asset_name that should be fetched via LEGACY_ASSET_BASE_URL.
 */
function isOldAssetUrl(value) {
  if (value == null) return false;
  const raw = String(value).trim();
  if (!raw) return false;
  if (/download-asset/i.test(raw) && /asset_name=/i.test(raw)) return true;
  if (/^https?:\/\//i.test(raw)) return true;
  // Bare S3-style legacy key (epoch-filename) — not a new MinIO key
  if (isNewMinioKey(raw)) return false;
  if (/^[A-Za-z0-9._\-/%]+$/.test(raw) && /\.[A-Za-z0-9]{2,5}$/.test(raw)) {
    return true;
  }
  return false;
}

/** New backend keys look like `folder/uuid.ext`. */
function isNewMinioKey(value) {
  if (value == null) return false;
  const raw = String(value).trim();
  if (!raw || /^https?:\/\//i.test(raw)) return false;
  if (/download-asset/i.test(raw)) return false;
  // uuid v4-ish segment after folder/
  return /^[a-z0-9_-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]+$/i.test(
    raw
  );
}

function extractAssetName(value) {
  const raw = String(value).trim();
  const match = raw.match(/[?&]asset_name=([^&]+)/i);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const base = path.basename(u.pathname);
      return base || 'file.bin';
    } catch {
      return path.basename(raw.split('?')[0]) || 'file.bin';
    }
  }
  return path.basename(raw) || 'file.bin';
}

function resolveDownloadUrl(value) {
  const raw = String(value).trim();
  const base = DEFAULT_LEGACY_BASE.replace(/\/$/, '');

  // Direct legacy S3 URLs are often private (HTTP 403). Prefer the public
  // download-asset API using the object key from the path.
  // e.g. https://tasdeeqimage.s3.us-east-2.amazonaws.com/1709...Logo.png
  const s3Match = raw.match(
    /^https?:\/\/tasdeeqimage\.s3[^/]*\.amazonaws\.com\/(.+)$/i
  );
  if (s3Match) {
    let key = s3Match[1].split('?')[0];
    try {
      key = decodeURIComponent(key);
    } catch {
      /* keep raw key */
    }
    return `${base}/api/file/download-asset?asset_name=${encodeURIComponent(key)}`;
  }

  if (/download-asset/i.test(raw) && /asset_name=/i.test(raw)) {
    if (/^https?:\/\//i.test(raw)) return raw;
    return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`;
  }

  if (/^https?:\/\//i.test(raw)) return raw;

  if (/download-asset/i.test(raw)) {
    return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`;
  }
  return `${base}/api/file/download-asset?asset_name=${encodeURIComponent(raw)}`;
}

/**
 * Download a legacy asset. Never throws — returns a result object.
 */
async function downloadOldAsset(urlOrRef) {
  try {
    if (urlOrRef == null || String(urlOrRef).trim() === '') {
      return { ok: false, error: 'empty url' };
    }

    const downloadUrl = resolveDownloadUrl(urlOrRef);
    const fileName = extractAssetName(urlOrRef);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let response;
    try {
      response = await fetch(downloadUrl, {
        method: 'GET',
        headers: { Accept: '*/*' },
        signal: controller.signal,
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} ${response.statusText}`,
        downloadUrl,
        fileName,
      };
    }

    const ab = await response.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (!buffer.length) {
      return {
        ok: false,
        error: 'empty response body',
        downloadUrl,
        fileName,
      };
    }

    // Legacy API lies with multipart/form-data — prefer extension
    const headerType = (response.headers.get('content-type') || '').split(';')[0].trim();
    let mimeType = mimeFromFileName(fileName);
    if (
      headerType &&
      headerType !== 'multipart/form-data' &&
      headerType !== 'application/octet-stream' &&
      !headerType.startsWith('text/')
    ) {
      mimeType = headerType;
    }

    return { ok: true, buffer, fileName, mimeType, downloadUrl };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      fileName: extractAssetName(urlOrRef),
    };
  }
}

/**
 * Download legacy asset (if needed) and upload to MinIO.
 * Stores/returns object key only. Idempotent via assetMap.json.
 *
 * @returns {Promise<string|null>}
 */
async function migrateAsset(value, { folder = 'uploads', migration, oldId, table } = {}) {
  try {
    if (value == null) return null;
    const original = String(value).trim();
    if (!original) return null;

    if (isNewMinioKey(original)) return original;

    const map = getAssetMap();
    if (map[original]) return map[original];

    // Also key by asset_name for reuse across full URL variants
    const assetName = extractAssetName(original);
    const altKey = `asset_name:${assetName}`;
    if (map[altKey]) {
      map[original] = map[altKey];
      return map[altKey];
    }

    if (!isOldAssetUrl(original) && !/^https?:\/\//i.test(original)) {
      // Unknown non-URL string — do not invent uploads
      logError({
        migration: migration || 'assets',
        oldId,
        message: `Unrecognized asset ref on ${table || 'unknown'} — skipped. value=${original.slice(0, 120)}`,
        stack: null,
      });
      return null;
    }

    const downloaded = await downloadOldAsset(original);
    if (!downloaded.ok) {
      logError({
        migration: migration || 'assets',
        oldId,
        message: `Asset download failed on ${table || 'unknown'}: ${downloaded.error}. url=${original.slice(0, 200)}`,
        stack: null,
      });
      return null;
    }

    try {
      const key = await uploadToMinio(
        downloaded.buffer,
        downloaded.fileName || assetName || 'file.bin',
        downloaded.mimeType || 'application/octet-stream',
        folder
      );
      map[original] = key;
      map[altKey] = key;
      return key;
    } catch (err) {
      logError({
        migration: migration || 'assets',
        oldId,
        message: `Asset upload failed on ${table || 'unknown'}: ${err.message}. url=${original.slice(0, 200)}`,
        stack: err.stack || null,
      });
      return null;
    }
  } catch (err) {
    logError({
      migration: migration || 'assets',
      oldId,
      message: `migrateAsset failed on ${table || 'unknown'}: ${err.message}`,
      stack: err.stack || null,
    });
    return null;
  }
}

/**
 * Run async work over items with limited concurrency.
 */
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }

  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

module.exports = {
  ASSET_MAP_NAME,
  isOldAssetUrl,
  isNewMinioKey,
  downloadOldAsset,
  migrateAsset,
  saveAssetMap,
  getAssetMap,
  getConcurrency,
  mapPool,
  extractAssetName,
  mimeFromFileName,
};
