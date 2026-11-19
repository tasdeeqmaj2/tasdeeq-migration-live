const fs = require('fs');
const path = require('path');

const ERRORS_PATH = path.join(__dirname, '..', 'logs', 'migration-errors.json');
const MAX_BUFFER = 500;

/** @type {Array<object>} */
let errorBuffer = [];

function ensureLogsDir() {
  const dir = path.dirname(ERRORS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadErrors() {
  ensureLogsDir();
  if (!fs.existsSync(ERRORS_PATH)) return [];
  try {
    const raw = fs.readFileSync(ERRORS_PATH, 'utf8');
    return raw.trim() ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function flushErrors() {
  if (errorBuffer.length === 0) return;
  ensureLogsDir();
  const existing = loadErrors();
  existing.push(...errorBuffer);
  // Cap file size so we don't write multi-GB logs
  const capped = existing.slice(-20000);
  fs.writeFileSync(ERRORS_PATH, JSON.stringify(capped), 'utf8');
  errorBuffer = [];
}

function logError({ migration, oldId, message, stack }) {
  errorBuffer.push({
    migration,
    oldId: oldId != null ? String(oldId) : null,
    message: message || 'Unknown error',
    stack: stack || null,
    at: new Date().toISOString(),
  });
  if (errorBuffer.length >= MAX_BUFFER) {
    flushErrors();
  }
}

function info(message) {
  console.log(message);
}

function success(message) {
  console.log(`✔ ${message}`);
}

function warn(message) {
  console.warn(`⚠ ${message}`);
}

function section(title) {
  console.log(`\n${title}`);
}

module.exports = {
  logError,
  flushErrors,
  info,
  success,
  warn,
  section,
  ERRORS_PATH,
};
