const crypto = require('crypto');

const DEFAULT_SECRET = process.env.OLD_ENCRYPTION_SECRET || 'tasdeeq1234abc';

/**
 * SHA-1 → first 16 bytes (AES-128), matching legacy EncryptionUtils.setKey.
 */
function setKey(myKey) {
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.from(String(myKey), 'utf8'))
    .digest();
  return digest.subarray(0, 16);
}

function getKey(secret = DEFAULT_SECRET) {
  return setKey(secret);
}

/**
 * True when value looks like a base64 AES-ECB ciphertext (16-byte blocks),
 * not a normal email/phone/CNIC.
 */
function looksEncrypted(value) {
  if (value == null) return false;
  const raw = String(value).trim();
  if (!raw || raw.length < 16) return false;
  if (raw.includes('@') && raw.includes('.')) return false;
  if (/^\d[\d\-\s]+$/.test(raw)) return false;
  if (!/^[A-Za-z0-9+/]+=*$/.test(raw)) return false;
  try {
    const buf = Buffer.from(raw, 'base64');
    return buf.length > 0 && buf.length % 16 === 0;
  } catch {
    return false;
  }
}

/**
 * Mirror of legacy EncryptionUtils.decrypt (AES-128-ECB / PKCS padding).
 * Returns the original string if decrypt fails.
 */
function decrypt(strToDecrypt, secret = DEFAULT_SECRET) {
  try {
    if (strToDecrypt == null) return strToDecrypt;
    const raw = String(strToDecrypt);
    const key = setKey(secret);
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(raw, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return strToDecrypt;
  }
}

/**
 * Same as decrypt(), with plain-looking values short-circuited first.
 * Prefer decryptIfEncrypted() at migration call sites.
 */
function decryptLegacy(value, secret = DEFAULT_SECRET) {
  if (value == null) return value;
  const raw = String(value).trim();
  if (!raw) return raw;

  if (raw.includes('@') && !/^[A-Za-z0-9+/=]+$/.test(raw)) return raw;
  if (/^\d[\d\-\s]+$/.test(raw)) return raw;

  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 0 || buf.length % 16 !== 0) return raw;

    const decipher = crypto.createDecipheriv('aes-128-ecb', getKey(secret), null);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([
      decipher.update(buf),
      decipher.final(),
    ]).toString('utf8');

    if (!decrypted || /[\x00-\x08\x0e-\x1f]/.test(decrypted)) return raw;
    return decrypted;
  } catch {
    return raw;
  }
}

/**
 * Decrypt only when the value appears encrypted.
 * Returns the decrypted string on success, the original value if plaintext,
 * and never throws.
 */
function decryptIfEncrypted(value) {
  try {
    if (value == null) return value;
    const raw = String(value).trim();
    if (!raw) return raw;
    if (!looksEncrypted(raw)) return raw;

    const decrypted = decryptLegacy(raw);
    if (
      decrypted == null ||
      String(decrypted).trim() === '' ||
      /[\x00-\x08\x0e-\x1f]/.test(String(decrypted))
    ) {
      return raw;
    }
    return String(decrypted).trim();
  } catch {
    try {
      return value == null ? value : String(value);
    } catch {
      return value;
    }
  }
}

function isValidEmail(value) {
  if (value == null) return false;
  const s = String(value).trim();
  if (!s || s.length > 254) return false;
  if (s.toLowerCase().endsWith('@migrated.invalid')) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * Accepts common PK / international forms (+92…, 03…, digits with spaces/dashes).
 * Rejects all-zero and too-short/too-long digit strings.
 */
function isValidPhone(value) {
  if (value == null) return false;
  const s = String(value).trim();
  if (!s) return false;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  if (/^0+$/.test(digits)) return false;
  return true;
}

module.exports = {
  setKey,
  decrypt,
  decryptLegacy,
  decryptIfEncrypted,
  looksEncrypted,
  isValidEmail,
  isValidPhone,
  DEFAULT_SECRET,
};
