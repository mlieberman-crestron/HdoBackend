const express = require('express');
const requireAuth = require('../middleware/auth');
const { runScheduledSync, getSyncHistory } = require('../jobs/syncJob');
const accountStore = require('../services/accountStore');
const sheetsService = require('../services/sheetsService');
const router = express.Router();

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
          const EPSILON = 0.002;
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
