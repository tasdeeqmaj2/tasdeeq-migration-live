/**
 * Clear id-mapping JSON files.
 * Use before migrating into a different NEW database (or after wiping the target).
 *
 *   node clearMaps.js
 *   npm run migrate:fresh
 */
require('dotenv').config();
const { clearAllMaps, MAPS_DIR } = require('./utils/maps');
const { info, section } = require('./utils/logger');

section('Clear migration maps');
const { cleared } = clearAllMaps();
info(`Cleared ${cleared} map file(s) from ${MAPS_DIR}`);
