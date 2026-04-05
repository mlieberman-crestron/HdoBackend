// Stores the mapping: Schwab account number → { googleSheetId, sheetName, startCell }
// In production, persist this to a database (SQLite, Postgres, etc.)
// For now, in-memory with a simple JSON file for persistence.

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '../config/account-mappings.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function getAllMappings() {
  return load();
}

function getMapping(schwabAccountNumber) {
  return load()[schwabAccountNumber] ?? null;
}

/**
 * Add or update a mapping.
 * @param {string} schwabAccountNumber
 * @param {string} googleSheetId  - Spreadsheet ID from the Google Sheets URL
 * @param {string} sheetName      - Tab name, e.g. "Portfolio" (default: "Holdings")
 * @param {string} startCell      - Top-left cell of the data block, e.g. "B3" (default: "A1")
 * @param {string} [displayName]  - Optional human-readable nickname for this account
 */
function setMapping(schwabAccountNumber, googleSheetId, sheetName = 'Holdings', startCell = 'A1', displayName) {
  const data = load();
  data[schwabAccountNumber] = { googleSheetId, sheetName, startCell };
  if (displayName !== undefined) data[schwabAccountNumber].displayName = displayName;
  save(data);
}

function removeMapping(schwabAccountNumber) {
  const data = load();
  delete data[schwabAccountNumber];
  save(data);
}

module.exports = { getAllMappings, getMapping, setMapping, removeMapping };
