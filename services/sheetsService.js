const { google } = require('googleapis');
const fs = require('fs');

function loadServiceAccountCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    return JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
  }
  return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function getAuthClient() {
  return new google.auth.GoogleAuth({
    credentials: loadServiceAccountCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

/**
 * Parse a cell address like "B3" into { col: 1, row: 2 } (0-indexed).
 */
function parseCell(cell = 'A1') {
  const match = cell.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!match) throw new Error(`Invalid cell address: "${cell}"`);
  const colLetters = match[1];
  const rowNum = parseInt(match[2], 10);
  let col = 0;
  for (const ch of colLetters) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1;
  return { col, row: rowNum - 1 };
}

/**
 * Convert a 0-based column index to a letter (0=A, 25=Z, 26=AA...)
 */
function colToLetter(col) {
  let letter = '';
  col += 1;
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

/**
 * Build an A1 range string for a block.
 */
function buildRange(sheetName, startCell, numRows, numCols) {
  const { col, row } = parseCell(startCell);
  const startColLetter = colToLetter(col);
  const endColLetter = colToLetter(col + numCols - 1);
  const startRow = row + 1;
  const endRow = startRow + numRows - 1;
  return `'${sheetName}'!${startColLetter}${startRow}:${endColLetter}${endRow}`;
}

// Only these 3 columns are written — Symbol (C), Shares (D), Avg Cost (E)
const COLUMNS = ['Symbol', 'Shares', 'Avg Cost'];
const MAX_ROW = 200;   // never write below this sheet row number
const CLEAR_COLS = 6;  // columns C–H cleared when a symbol is removed (C=Symbol, D=Shares, E=AvgCost, F=ManualPrice, G=AnnualDiv, H=Sector)

function positionToRow(pos) {
  const instrument = pos.instrument || {};
  const qty = pos.longQuantity ?? pos.shortQuantity ?? 0;
  const avg = pos.averagePrice;
  return [
    instrument.symbol ?? '',
    Math.round(qty * 10000) / 10000,                                   // 4 dp — fractional shares
    avg != null ? Math.round(avg * 10000) / 10000 : '',                // 4 dp — sub-cent precision
  ];
}

/**
 * Update holdings in-place in a Google Sheet.
 * - Reads existing data starting at startCell on sheetName
 * - Matches rows by symbol (first column relative to startCell)
 * - Updates values for existing symbols
 * - Appends new symbols below existing data
 * - Leaves all other rows/columns in the spreadsheet untouched
 *
 * @param {string} spreadsheetId  - Google Sheet ID from the URL
 * @param {Array}  positions      - Position objects from Schwab API
 * @param {string} sheetName      - Tab name, e.g. "Portfolio"
 * @param {string} startCell      - Top-left cell of the data block, e.g. "B3"
 */
async function writeHoldingsToSheet(
  spreadsheetId,
  positions,
  sheetName = 'Holdings',
  startCell = 'A1'
) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const { col: startCol, row: startRow } = parseCell(startCell);
  const NUM_COLS = COLUMNS.length;
  const maxDataRows = MAX_ROW - startRow; // rows available within the allowed range

  // ── Step 1: Read existing data (never read beyond MAX_ROW) ─────────────────
  const readRange = buildRange(sheetName, startCell, maxDataRows, NUM_COLS);
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: readRange,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const existingRows = readRes.data.values ?? [];

  // Map symbol → row index (no header row — user manages their own headers)
  const symbolRowMap = {};
  existingRows.forEach((row, i) => {
    const sym = row[0];
    if (sym) symbolRowMap[sym] = i;
  });

  // ── Step 2: Build batch updates ────────────────────────────────────────────
  const batchData = [];
  const newRows = [];

  for (const pos of positions) {
    const symbol = pos.instrument?.symbol;
    if (!symbol) continue;

    const rowData = positionToRow(pos);

    if (symbol in symbolRowMap) {
      // Update existing row in-place
      const sheetRowNum = startRow + symbolRowMap[symbol] + 1;
      const cellAddr = `${colToLetter(startCol)}${sheetRowNum}`;
      batchData.push({ range: buildRange(sheetName, cellAddr, 1, NUM_COLS), values: [rowData] });
    } else {
      newRows.push(rowData);
    }
  }

  // ── Clear rows for symbols no longer in the portfolio ─────────────────────
  const incomingSymbols = new Set(positions.map((p) => p.instrument?.symbol).filter(Boolean));
  const removedSymbols = Object.keys(symbolRowMap).filter((sym) => !incomingSymbols.has(sym));

  for (const sym of removedSymbols) {
    const sheetRowNum = startRow + symbolRowMap[sym] + 1;
    const cellAddr = `${colToLetter(startCol)}${sheetRowNum}`;
    batchData.push({
      range: buildRange(sheetName, cellAddr, 1, CLEAR_COLS),
      values: [Array(CLEAR_COLS).fill('')],
    });
  }

  // Append new symbols below existing data, capped at MAX_ROW
  if (newRows.length > 0) {
    const appendStartSheetRow = startRow + existingRows.length + 1;
    const rowsAvailable = MAX_ROW - appendStartSheetRow + 1;
    const rowsToWrite = newRows.slice(0, rowsAvailable);
    if (rowsToWrite.length > 0) {
      const appendCellAddr = `${colToLetter(startCol)}${appendStartSheetRow}`;
      batchData.push({
        range: buildRange(sheetName, appendCellAddr, rowsToWrite.length, NUM_COLS),
        values: rowsToWrite,
      });
    }
    if (rowsToWrite.length < newRows.length) {
      console.warn(`[sheets] ${newRows.length - rowsToWrite.length} new symbols skipped — MAX_ROW ${MAX_ROW} reached`);
    }
  }

  // ── Step 3: Execute batch ──────────────────────────────────────────────────
  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: batchData },
    });
  }

  const updatedCount = positions.length - newRows.length;
  const syncTime = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  console.log(`[sheets] "${sheetName}" @ ${startCell}: ${updatedCount} updated, ${newRows.length} new, ${removedSymbols.length} cleared — ${syncTime}`);
  return { updatedSymbols: updatedCount, newSymbols: newRows.length, clearedSymbols: removedSymbols.length, syncTime };
}


/**
 * Read existing holdings from a sheet. Returns array of row objects.
 */
async function readHoldingsFromSheet(spreadsheetId, sheetName = 'Holdings', startCell = 'A1') {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const { row: startRow } = parseCell(startCell);
  const readRange = buildRange(sheetName, startCell, MAX_ROW - startRow, COLUMNS.length);
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId, range: readRange, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = readRes.data.values ?? [];
  return rows.map((row) => ({
    symbol: row[0] ?? '',
    quantity: row[1] ?? 0,
    averagePrice: row[2] ?? 0,
  }));
}

/**
 * Restore only shares (Quantity) and avgPrice columns from a backup.
 * Matches rows by symbol. All other columns untouched.
 */
async function restoreBackupColumns(spreadsheetId, sheetName = 'Holdings', startCell = 'A1', rows = []) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const { col: startCol, row: startRow } = parseCell(startCell);
  const readRange = buildRange(sheetName, startCell, 500, COLUMNS.length);
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId, range: readRange, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const existingRows = readRes.data.values ?? [];
  const symbolRowMap = {};
  existingRows.forEach((row, i) => { if (row[0]) symbolRowMap[row[0]] = i; });

  const batchData = [];
  for (const { symbol, shares, avgPrice } of rows) {
    const rowIndex = symbolRowMap[symbol];
    if (rowIndex === undefined) continue;
    const sheetRowNum = startRow + rowIndex + 1;
    // col+1 = Shares, col+2 = Avg Cost
    batchData.push({ range: `'${sheetName}'!${colToLetter(startCol + 1)}${sheetRowNum}`, values: [[shares]] });
    batchData.push({ range: `'${sheetName}'!${colToLetter(startCol + 2)}${sheetRowNum}`, values: [[avgPrice]] });
  }
  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: batchData },
    });
  }
  console.log(`[sheets] restore: ${batchData.length / 2} rows written to "${sheetName}"`);
  return { restoredCount: batchData.length / 2 };
}

/**
 * Check whether the service account can read and write a given spreadsheet.
 * Returns { ok, canRead, canWrite, serviceAccountEmail }.
 */
async function checkSheetPermissions(spreadsheetId) {
  const auth = getAuthClient();
  const serviceAccount = loadServiceAccountCredentials();
  const serviceAccountEmail = serviceAccount.client_email ?? 'unknown';

  const sheets = google.sheets({ version: 'v4', auth });

  let canRead = false;
  let canWrite = false;

  // Test read: fetch spreadsheet metadata
  try {
    await sheets.spreadsheets.get({ spreadsheetId });
    canRead = true;
  } catch {
    // 403 or 404 — no read access
  }

  // Test write: attempt a no-op batchUpdate (empty data array)
  if (canRead) {
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'USER_ENTERED', data: [] },
      });
      canWrite = true;
    } catch {
      // 403 — read-only access
    }
  }

  return { ok: canRead && canWrite, canRead, canWrite, serviceAccountEmail };
}

/**
 * Read security metadata from the "2 HDO" and "3 Non-HDO" tabs of the HDO Portfolio Tracker.
 *
 * Column layout (reading from B, so array index 0 = col B):
 *   [0]  B  = Symbol
 *   [1-3] C-E = Name/description
 *   [9]  K  = Min allocation %
 *   [10] L  = Max allocation %
 *   [17] S  = Buy Under $
 *   [22] X  = Sector
 *   [23] Y  = Portfolio Section
 *   [24] Z  = Risk rating
 */
async function readPortfolioMetadata(spreadsheetId) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: ["'2 HDO'!B9:Z82", "'3 Non-HDO'!B9:Z25"],
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const [hdoRows, nonHdoRows] = res.data.valueRanges.map((vr) => vr.values ?? []);

  function parseRow(row, source) {
    const symbol = (row[0] ?? '').toString().trim();
    if (!symbol) return null;
    return {
      symbol,
      name: [row[1], row[2], row[3]].filter(Boolean).join(' ').trim(),
      minAlloc: parseFloat(row[9]) || 0,
      maxAlloc: parseFloat(row[10]) || 0,
      buyUnder: parseFloat(row[17]) || null,
      sector: (row[22] ?? '').toString().trim(),
      portfolioSection: (row[23] ?? '').toString().trim(),
      risk: (row[24] ?? '').toString().trim(),
      source,
    };
  }

  return [
    ...hdoRows.map((r) => parseRow(r, 'HDO')).filter(Boolean),
    ...nonHdoRows.map((r) => parseRow(r, 'Non-HDO')).filter(Boolean),
  ];
}

// Read prices from Import!B410:C470 (symbol=B, price=C)
// "3 Non-HDO"!B9:P30 (symbol=B, price=P, offset 14)
// "2 HDO"!B9:T82 (symbol=B, price=T, offset 18)
async function readPriceColumn(spreadsheetId) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: ["'Import'!B410:C470", "'3 Non-HDO'!B9:P30", "'2 HDO'!B9:T82"],
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const priceMap = {};

  const [importRows, nonHdoRows, hdoRows] = res.data.valueRanges.map((vr) => vr.values ?? []);

  for (const row of importRows) {
    const symbol = (row[0] ?? '').toString().trim();
    if (symbol && row[1] !== undefined && row[1] !== '') priceMap[symbol] = Number(row[1]);
  }
  for (const row of nonHdoRows) {
    const symbol = (row[0] ?? '').toString().trim();
    if (symbol && row[14] !== undefined && row[14] !== '') priceMap[symbol] = Number(row[14]);
  }
  for (const row of hdoRows) {
    const symbol = (row[0] ?? '').toString().trim();
    if (symbol && row[18] !== undefined && row[18] !== '') priceMap[symbol] = Number(row[18]);
  }

  return Object.entries(priceMap).map(([symbol, sheetPrice]) => ({ symbol, sheetPrice }));
}

module.exports = { writeHoldingsToSheet, readHoldingsFromSheet, readPriceColumn, restoreBackupColumns, checkSheetPermissions, readPortfolioMetadata };
