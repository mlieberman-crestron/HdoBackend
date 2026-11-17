const express = require('express');
const requireAuth = require('../middleware/auth');
const { runScheduledSync, getSyncHistory } = require('../jobs/syncJob');
const accountStore = require('../services/accountStore');
const sheetsService = require('../services/sheetsService');
const router = express.Router();

// GET /sync/price-diff — compare sheet manual price (col F) vs Schwab current price
router.get('/price-diff', requireAuth, async (req, res) => {
  const mappings = accountStore.getAllMappings();
  const schwabService = require('../services/schwabService');
  const sheetsServiceModule = require('../services/sheetsService');

  const schwabPrices = {};
  const allAccounts = await schwabService.getHoldings();
  for (const acct of allAccounts) {
    for (const pos of acct.securitiesAccount?.positions ?? []) {
      const symbol = pos.instrument?.symbol;
      const qty = pos.longQuantity ?? pos.shortQuantity ?? 0;
      if (!symbol || qty === 0) continue;
      if (!schwabPrices[symbol]) schwabPrices[symbol] = { marketValue: 0, qty: 0 };
      schwabPrices[symbol].marketValue += pos.marketValue;
      schwabPrices[symbol].qty += qty;
    }
  }
  for (const sym of Object.keys(schwabPrices)) {
    const { marketValue, qty } = schwabPrices[sym];
    schwabPrices[sym].price = Math.round((marketValue / qty) * 10000) / 10000;
  }

  const seenSheets = new Set();
  const seen = new Set();
  const results = [];
  for (const [, { googleSheetId }] of Object.entries(mappings)) {
    if (seenSheets.has(googleSheetId)) continue;
    seenSheets.add(googleSheetId);
    const rows = await sheetsServiceModule.readPriceColumn(googleSheetId);
    for (const { symbol, sheetPrice } of rows) {
      if (!symbol || sheetPrice === '' || sheetPrice === null || seen.has(symbol)) continue;
      seen.add(symbol);
      const schwab = schwabPrices[symbol];
      if (!schwab) continue;
      const diff = Math.round((schwab.price - Number(sheetPrice)) * 10000) / 10000;
      if (Math.abs(diff) > 0.00005) {
        results.push({ symbol, sheetPrice: Number(sheetPrice), schwabPrice: schwab.price, diff });
      }
    }
  }

  results.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  res.json({ discrepancies: results });
});

// GET /sync/sheet-prices — show what prices are being read from the sheet (col T)
router.get('/sheet-prices', requireAuth, async (req, res) => {
  const mappings = accountStore.getAllMappings();
  const sheetsServiceModule = require('../services/sheetsService');
  const seenSheets = new Set();
  const results = [];
  for (const [, { googleSheetId }] of Object.entries(mappings)) {
    if (seenSheets.has(googleSheetId)) continue;
    seenSheets.add(googleSheetId);
    results.push(...await sheetsServiceModule.readPriceColumn(googleSheetId));
  }
  res.json({ prices: results });
});

// GET /sync/value-diff — compare market value per symbol, per account mapping
router.get('/value-diff', requireAuth, async (req, res) => {
  const mappings = accountStore.getAllMappings();
  const schwabService = require('../services/schwabService');
  const sheetsServiceModule = require('../services/sheetsService');

  const allAccounts = await schwabService.getHoldings();
  const results = [];

  for (const [schwabAccountId, { googleSheetId, sheetName, startCell }] of Object.entries(mappings)) {
    // Positions for this specific account only
    const account = allAccounts.find((a) => a.securitiesAccount?.accountNumber === schwabAccountId);
    if (!account) continue;

    const schwabBySymbol = {};
    for (const pos of account.securitiesAccount?.positions ?? []) {
      const symbol = pos.instrument?.symbol;
      const qty = pos.longQuantity ?? pos.shortQuantity ?? 0;
      if (!symbol) continue;
      schwabBySymbol[symbol] = {
        marketValue: pos.marketValue ?? 0,
        qty,
        price: qty > 0 ? Math.round(((pos.marketValue ?? 0) / qty) * 10000) / 10000 : 0,
      };
    }

    // Sheet holdings and prices for this mapping
    const holdings = await sheetsServiceModule.readHoldingsFromSheet(googleSheetId, sheetName, startCell);
    const sheetShares = {};
    for (const row of holdings) {
      if (row.symbol) sheetShares[row.symbol] = Number(row.quantity ?? 0);
    }
    const sheetPrices = {};
    const prices = await sheetsServiceModule.readPriceColumn(googleSheetId);
    for (const { symbol, sheetPrice } of prices) {
      if (symbol && sheetPrice !== '') sheetPrices[symbol] = Number(sheetPrice);
    }

    // Compare per symbol
    const allSymbols = new Set([...Object.keys(schwabBySymbol), ...Object.keys(sheetShares)]);
    const discrepancies = [];
    let schwabTotal = 0;
    let sheetTotal = 0;

    for (const symbol of allSymbols) {
      const schwab = schwabBySymbol[symbol];
      const shares = sheetShares[symbol] ?? 0;
      const price = sheetPrices[symbol] ?? 0;
      const schwabValue = Math.round((schwab?.marketValue ?? 0) * 100) / 100;
      const sheetValue = Math.round(shares * price * 100) / 100;
      const diff = Math.round((schwabValue - sheetValue) * 100) / 100;
      schwabTotal += schwabValue;
      sheetTotal += sheetValue;
      if (Math.abs(diff) > 0.5) {
        discrepancies.push({ symbol, schwabValue, sheetValue, diff, schwabShares: schwab?.qty ?? 0, sheetShares: shares, schwabPrice: schwab?.price ?? 0, sheetPrice: price });
      }
    }

    discrepancies.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    results.push({
      schwabAccountId,
      googleSheetId,
      sheetName,
      schwabTotal: Math.round(schwabTotal * 100) / 100,
      sheetTotal: Math.round(sheetTotal * 100) / 100,
      totalDiff: Math.round((schwabTotal - sheetTotal) * 100) / 100,
      discrepancies,
    });
  }

  res.json({ accounts: results });
});

// GET /sync/diff — compare Schwab quantities vs sheet, return only discrepancies
router.get('/diff', requireAuth, async (req, res) => {
  const mappings = accountStore.getAllMappings();
  const schwabService = require('../services/schwabService');
  const results = [];

  for (const [schwabAccountId, { googleSheetId, sheetName, startCell }] of Object.entries(mappings)) {
    const allAccounts = await schwabService.getHoldings(schwabAccountId);
    const account = allAccounts.find((a) => a.securitiesAccount?.accountNumber === schwabAccountId);
    if (!account) continue;

    const positions = account.securitiesAccount?.positions ?? [];
    const sheetRows = await sheetsService.readHoldingsFromSheet(googleSheetId, sheetName, startCell);

    const sheetBySymbol = {};
    for (const row of sheetRows) {
      if (row.symbol) sheetBySymbol[row.symbol] = row;
    }

    for (const pos of positions) {
      const symbol = pos.instrument?.symbol;
      if (!symbol) continue;
      const schwabQty = pos.longQuantity ?? pos.shortQuantity ?? 0;
      const sheetQty = parseFloat(sheetBySymbol[symbol]?.quantity ?? 'NaN');
      const diff = Math.abs(schwabQty - sheetQty);
      if (isNaN(sheetQty) || diff > 0.0001) {
        results.push({ symbol, schwabQty, sheetQty: isNaN(sheetQty) ? 'missing' : sheetQty, diff: isNaN(sheetQty) ? 'N/A' : diff.toFixed(6) });
      }
    }
  }

  results.sort((a, b) => (parseFloat(b.diff) || 0) - (parseFloat(a.diff) || 0));
  res.json({ discrepancies: results });
});

// POST /sync/run — trigger a manual sync
router.post('/run', requireAuth, async (req, res) => {
  try {
    const result = await runScheduledSync();
    res.json(result);
  } catch (err) {
    console.error('[sync/run]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /sync/history — last 50 sync results
router.get('/history', requireAuth, (req, res) => {
  res.json({ history: getSyncHistory() });
});

// POST /sync/preview
// Fetches from Schwab + diffs against current sheet — does NOT write anything
// Optional body: { accountId } to preview a single account only
router.post('/preview', requireAuth, async (req, res) => {
  const mappings = accountStore.getAllMappings();
  const { accountId } = req.body ?? {};
  const accountIds = accountId
    ? (mappings[accountId] ? [accountId] : [])
    : Object.keys(mappings);

  if (accountIds.length === 0) {
    return res.json({ previews: [] });
  }

  // Import schwabService lazily to avoid circular deps
  const schwabService = require('../services/schwabService');
  const previews = [];

  for (const schwabAccountId of accountIds) {
    const { googleSheetId, sheetName, startCell } = mappings[schwabAccountId];
    const entry = {
      schwabAccountId,
      sheetName,
      startCell,
      status: 'ok',
      changes: [],
      totalPositions: 0,
    };

    try {
      // Fetch from Schwab
      const allAccounts = await schwabService.getHoldings(schwabAccountId);
      const account = allAccounts.find(
        (a) => a.securitiesAccount?.accountNumber === schwabAccountId
      );
      if (!account) throw new Error(`Account ${schwabAccountId} not found in Schwab response`);

      const positions = account.securitiesAccount?.positions ?? [];
      entry.totalPositions = positions.length;

      // Read current sheet state
      const currentRows = await sheetsService.readHoldingsFromSheet(
        googleSheetId, sheetName, startCell
      );

      // Build lookup maps
      const currentBySymbol = {};
      for (const row of currentRows) {
        if (row.symbol) currentBySymbol[row.symbol] = row;
      }
      const incomingBySymbol = {};
      for (const pos of positions) {
        const sym = pos.instrument?.symbol;
        if (sym) incomingBySymbol[sym] = pos;
      }

      // Diff incoming vs current
      for (const pos of positions) {
        const symbol = pos.instrument?.symbol;
        if (!symbol) continue;
        const current = currentBySymbol[symbol];

        if (!current) {
          entry.changes.push({ symbol, field: 'All cols', was: '', now: 'New position', type: 'new' });
        } else {
          const EPSILON = 0.00005;
          const changed = (a, b) => Math.abs(Number(a ?? 0) - Number(b ?? 0)) > EPSILON;
          const checks = [
            { field: 'Qty',       was: current.quantity,     now: pos.longQuantity ?? pos.shortQuantity ?? 0 },
            { field: 'Avg price', was: current.averagePrice, now: pos.averagePrice },
          ];
          for (const c of checks) {
            if (changed(c.was, c.now)) {
              entry.changes.push({ symbol, field: c.field, was: c.was, now: c.now, type: 'changed' });
            }
          }
        }
      }

      // Detect removed positions
      for (const sym of Object.keys(currentBySymbol)) {
        if (!incomingBySymbol[sym]) {
          entry.changes.push({ symbol: sym, field: 'Position', was: sym, now: '', type: 'removed' });
        }
      }

      // Include full current sheet state so the frontend can save an accurate backup
      entry.currentRows = currentRows
        .filter((r) => r.symbol)
        .map((r) => ({ symbol: r.symbol, shares: r.quantity, avgPrice: r.averagePrice }));

    } catch (err) {
      entry.status = 'error';
      entry.error = err.message;
    }

    previews.push(entry);
  }

  res.json({ previews });
});

// POST /sync/restore
// Writes only symbol/shares/avgPrice back into the sheet for one account
router.post('/restore', requireAuth, async (req, res) => {
  const { schwabAccountId, rows } = req.body;

  if (!schwabAccountId || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'schwabAccountId and rows[] are required' });
  }

  const mapping = accountStore.getMapping(schwabAccountId);
  if (!mapping) {
    return res.status(404).json({ error: `No mapping found for account ${schwabAccountId}` });
  }

  const { googleSheetId, sheetName, startCell } = mapping;

  try {
    await sheetsService.restoreBackupColumns(googleSheetId, sheetName, startCell, rows);
    res.json({ success: true, restored: rows.length });
  } catch (err) {
    console.error('[sync/restore]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
