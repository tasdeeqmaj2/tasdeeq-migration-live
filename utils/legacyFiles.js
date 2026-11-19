/**
 * Legacy old-backend file links look like:
 *   https://host/.../download-asset?asset_name=prelive/foo.jpg
 *   http://localhost:8080/api/file/download-asset?asset_name=foo.jpg
 *
 * New storage expects MinIO object keys (see utils/migrateAsset.js).
 * Prefer migrateAsset() for any field that should land in logoKey / key / cnic*Key.
 */

function isAbsoluteUrl(value) {
  if (!value) return false;
  return /^https?:\/\//i.test(String(value).trim());
}

/**
 * Trim-only normalize. Does NOT upload — use migrateAsset for MinIO migration.
 */
function normalizeLegacyFileRef(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  return raw;
}

function docNameFromVerificationType(documentType) {
  const t = String(documentType || '')
    .trim()
    .toLowerCase();
  if (t.includes('front')) return 'cnic-front';
  if (t.includes('back')) return 'cnic-back';
  if (t.includes('utility')) return 'utility-bill';
  if (t.includes('photo') || t.includes('picture')) return 'photo';
  return t ? t.replace(/\s+/g, '-') : 'document';
}

module.exports = {
  isAbsoluteUrl,
  normalizeLegacyFileRef,
  docNameFromVerificationType,
};
