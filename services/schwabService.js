/**
 * services/schwabService.js
 *
 * Handles Schwab API calls and token refresh.
 * Token store is in-memory — move to a DB (SQLite/Postgres) before production.
 */

const { getSchwabToken } = require('../routes/schwab');

const SCHWAB_API = 'https://api.schwabapi.com';

async function getValidToken() {
  const tokenData = getSchwabToken();
  if (!tokenData) {
    throw new Error('Schwab not connected. Complete OAuth flow first via /schwab/connect.');
  }

  // Refresh if token expires within 5 minutes
  const expiresAt = tokenData.acquired_at + (tokenData.expires_in * 1000);
  const fiveMinutes = 5 * 60 * 1000;

  if (Date.now() > expiresAt - fiveMinutes) {
    return refreshToken(tokenData.refresh_token);
  }

  return tokenData.access_token;
}

async function refreshToken(refreshToken) {
  const { SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET } = process.env;
  const credentials = Buffer.from(`${SCHWAB_CLIENT_ID}:${SCHWAB_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(`${SCHWAB_API}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to refresh Schwab token — please reconnect via /schwab/connect');
  }

  const tokens = await response.json();
  // Update stored token
  const schwabRoute = require('../routes/schwab');
  if (schwabRoute.updateToken) schwabRoute.updateToken(tokens);

  return tokens.access_token;
}

async function getHoldings(accountNumber) {
  const token = await getValidToken();

  const response = await fetch(
    `${SCHWAB_API}/trader/v1/accounts?fields=positions`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Schwab API error ${response.status}: ${body}`);
  }

  return response.json();
}

async function getBalances() {
  const token = await getValidToken();
  const response = await fetch(`${SCHWAB_API}/trader/v1/accounts`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Schwab API error ${response.status}: ${body}`);
  }
  const data = await response.json();
  const balances = {};
  for (const a of data) {
    const acct = a.securitiesAccount;
    if (!acct?.accountNumber) continue;
    const b = acct.currentBalances ?? {};
    balances[acct.accountNumber] = {
      totalValue: b.liquidationValue ?? null,
      cash: b.cashBalance ?? b.totalCash ?? null,
    };
  }
  return balances;
}

/**
 * Fetch live quotes for an array of ticker symbols.
 * Returns an object keyed by symbol, each with { price, annualDividend, dividendYield }.
 */
async function getQuotes(symbols) {
  if (!symbols || symbols.length === 0) return {};
  const token = await getValidToken();

  // Batch into chunks of 500 (Schwab API limit)
  const results = {};
  for (let i = 0; i < symbols.length; i += 500) {
    const chunk = symbols.slice(i, i + 500);
    const params = new URLSearchParams({ symbols: chunk.join(','), fields: 'quote,fundamental' });
    const response = await fetch(
      `${SCHWAB_API}/marketdata/v1/quotes?${params}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Schwab quotes API error ${response.status}: ${body}`);
    }
    const data = await response.json();
    for (const [symbol, val] of Object.entries(data)) {
      results[symbol] = {
        price: val.quote?.lastPrice ?? val.quote?.mark ?? null,
        annualDividend: val.fundamental?.dividendAmount ?? null,
        dividendYield: val.fundamental?.dividendYield ?? null,
      };
    }
  }
  return results;
}

/**
 * Proactively refresh the Schwab access token if it expires within 10 minutes.
 * Safe to call on a timer — does nothing if not connected or not near expiry.
 */
async function proactiveRefresh() {
  const tokenData = require('../routes/schwab').getSchwabToken();
  if (!tokenData?.access_token) return; // not connected

  const expiresAt = tokenData.acquired_at + (tokenData.expires_in * 1000);
  const tenMinutes = 10 * 60 * 1000;

  if (Date.now() > expiresAt - tenMinutes) {
    try {
      await refreshToken(tokenData.refresh_token);
      console.log('[schwab] Token proactively refreshed');
    } catch (err) {
      console.warn('[schwab] Proactive refresh failed:', err.message);
    }
  }
}

module.exports = { getHoldings, getBalances, getQuotes, proactiveRefresh };
