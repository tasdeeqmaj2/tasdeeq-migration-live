const { logError } = require('./logger');
const {
  decryptIfEncrypted,
  isValidEmail,
  isValidPhone,
} = require('./decrypt');

function preview(value, max = 80) {
  if (value == null) return String(value);
  const s = String(value);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Decrypt-if-needed + validate email.
 * @returns {string|null} valid email, or null when missing/invalid
 */
function resolveEmail(value, { migration, oldId } = {}) {
  try {
    if (value == null || String(value).trim() === '') return null;

    const original = String(value).trim();
    const resolved = decryptIfEncrypted(original);

    if (isValidEmail(resolved)) return String(resolved).trim();

    logError({
      migration: migration || 'contact_fields',
      oldId,
      message: `Invalid email — not stored. original=${preview(original)} resolved=${preview(resolved)}`,
      stack: null,
    });
    return null;
  } catch (err) {
    logError({
      migration: migration || 'contact_fields',
      oldId,
      message: `Email resolve failed: ${err.message}`,
      stack: err.stack || null,
    });
    return null;
  }
}

/**
 * Decrypt-if-needed + validate phone.
 * @param {object} [opts]
 * @param {boolean} [opts.required=false] When true and invalid/missing, keep the
 *   original string (for NOT NULL columns like workers.mobile) instead of null.
 * @returns {string|null}
 */
function resolvePhone(value, { migration, oldId, required = false } = {}) {
  try {
    if (value == null || String(value).trim() === '') {
      if (required) {
        logError({
          migration: migration || 'contact_fields',
          oldId,
          message: 'Missing phone — required column; keeping empty string',
          stack: null,
        });
        return '';
      }
      return null;
    }

    const original = String(value).trim();
    const resolved = decryptIfEncrypted(original);

    if (isValidPhone(resolved)) return String(resolved).trim();

    logError({
      migration: migration || 'contact_fields',
      oldId,
      message: `Invalid phone — not stored as placeholder. original=${preview(original)} resolved=${preview(resolved)}`,
      stack: null,
    });

    // Safest for NOT NULL mobile columns: keep original (never invent 000…)
    if (required) return original;
    return null;
  } catch (err) {
    logError({
      migration: migration || 'contact_fields',
      oldId,
      message: `Phone resolve failed: ${err.message}`,
      stack: err.stack || null,
    });
    if (required) {
      try {
        return value == null ? '' : String(value);
      } catch {
        return '';
      }
    }
    return null;
  }
}

module.exports = {
  resolveEmail,
  resolvePhone,
  decryptIfEncrypted,
  isValidEmail,
  isValidPhone,
};
