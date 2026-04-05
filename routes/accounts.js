const express = require('express');
const requireAuth = require('../middleware/auth');
const accountStore = require('../services/accountStore');
const { checkSheetPermissions } = require('../services/sheetsService');
const { getPortfolioAnalysis } = require('../services/portfolioAnalysisService');
const router = express.Router();

// GET /accounts — list all account mappings
router.get('/', requireAuth, (req, res) => {
  res.json({ mappings: accountStore.getAllMappings() });
});

// POST /accounts — add or update a mapping
// Body: { schwabAccountNumber, googleSheetId, sheetName, startCell, displayName? }
router.post('/', requireAuth, (req, res) => {
  const { schwabAccountNumber, googleSheetId, sheetName, startCell, displayName } = req.body;
  if (!schwabAccountNumber || !googleSheetId) {
    return res.status(400).json({ error: 'schwabAccountNumber and googleSheetId are required' });
  }
  accountStore.setMapping(schwabAccountNumber, googleSheetId, sheetName, startCell, displayName);
  res.json({ success: true, schwabAccountNumber, googleSheetId, sheetName, startCell, displayName });
});

// DELETE /accounts/:accountNumber — remove a mapping
router.delete('/:accountNumber', requireAuth, (req, res) => {
  accountStore.removeMapping(req.params.accountNumber);
  res.json({ success: true });
});

// GET /accounts/:accountNumber/check-permissions
// Verifies the service account has read + write access to the mapped sheet.
router.get('/:accountNumber/check-permissions', requireAuth, async (req, res) => {
  const mapping = accountStore.getMapping(req.params.accountNumber);
  if (!mapping) {
    return res.status(404).json({ error: `No mapping found for account ${req.params.accountNumber}` });
  }
  try {
    const result = await checkSheetPermissions(mapping.googleSheetId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /accounts/:accountNumber/analysis
// Reads "2 HDO" + "3 Non-HDO" tabs, fetches Schwab quotes, returns calculated metrics
router.get('/:accountNumber/analysis', requireAuth, async (req, res) => {
  const mapping = accountStore.getMapping(req.params.accountNumber);
  if (!mapping) {
    return res.status(404).json({ error: `No mapping found for account ${req.params.accountNumber}` });
  }
  try {
    const result = await getPortfolioAnalysis(mapping.googleSheetId, mapping.sheetName, mapping.startCell);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
