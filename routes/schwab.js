const express = require('express');
const requireAuth = require('../middleware/auth');
const { saveTokens, loadTokens } = require('../services/tokenStore');
const router = express.Router();

// Load persisted tokens on startup
let schwabTokens = { default: loadTokens() };

// GET /schwab/connect
// Returns the Schwab OAuth authorization URL
router.get('/connect', requireAuth, (req, res) => {
  const { SCHWAB_CLIENT_ID, SCHWAB_REDIRECT_URI } = process.env;

  if (!SCHWAB_CLIENT_ID || !SCHWAB_REDIRECT_URI) {
    return res.status(500).json({
      error: 'Schwab credentials not configured. Set SCHWAB_CLIENT_ID and SCHWAB_REDIRECT_URI in .env'
    });
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SCHWAB_CLIENT_ID,
    redirect_uri: SCHWAB_REDIRECT_URI,
    scope: 'readonly',
  });

  const url = `https://api.schwabapi.com/v1/oauth/authorize?${params}`;
  res.json({ url });
});

// GET /schwab/callback
// Schwab redirects here after user logs in
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    const { SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET, SCHWAB_REDIRECT_URI } = process.env;
    const credentials = Buffer.from(`${SCHWAB_CLIENT_ID}:${SCHWAB_CLIENT_SECRET}`).toString('base64');

    const response = await fetch('https://api.schwabapi.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SCHWAB_REDIRECT_URI,
      }),
    });

    const tokens = await response.json();

    if (!response.ok || tokens.error) {
      console.error('[schwab] Token exchange failed:', JSON.stringify(tokens));
      return res.status(500).send(`Token exchange failed: ${tokens.error_description ?? tokens.error ?? response.status}`);
    }

    schwabTokens['default'] = {
      ...tokens,
      acquired_at: Date.now(),
    };
    saveTokens(schwabTokens['default']);

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=hdosync://schwab-callback?success=true">
</head>
<body>
  <p>Schwab connected. Returning to app&hellip;</p>
  <script>window.location.replace('hdosync://schwab-callback?success=true');</script>
</body>
</html>`);
  } catch (err) {
    console.error('[schwab] Callback error:', err.message);
    res.status(500).send(`Failed to exchange code for token: ${err.message}`);
  }
});

// GET /schwab/status
router.get('/status', requireAuth, (_req, res) => {
  const tokenData = schwabTokens['default'];
  res.json({ connected: !!tokenData?.access_token });
});

// GET /schwab/accounts
// Lists Schwab accounts using stored token
router.get('/accounts', requireAuth, async (req, res) => {
  const tokenData = schwabTokens['default'];
  if (!tokenData) {
    return res.status(401).json({ error: 'Schwab not connected. Visit /schwab/connect first.' });
  }

  try {
    const response = await fetch('https://api.schwabapi.com/trader/v1/accounts', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const data = await response.json();
    // Transform to the shape the app expects: [{ accountNumber, accountType }]
    const accounts = Array.isArray(data)
      ? data.map((a) => ({
          accountNumber: a.securitiesAccount?.accountNumber ?? '',
          accountType: a.securitiesAccount?.type ?? '',
        }))
      : [];
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /schwab/positions — raw holdings from Schwab (for debugging)
router.get('/positions', requireAuth, async (_req, res) => {
  const schwabService = require('../services/schwabService');
  try {
    const data = await schwabService.getHoldings();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export token store so syncJob can use it
module.exports = router;
module.exports.getSchwabToken = () => schwabTokens['default'];
module.exports.updateToken = (tokens) => {
  schwabTokens['default'] = { ...tokens, acquired_at: Date.now() };
  saveTokens(schwabTokens['default']);
};
