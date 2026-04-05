const schwabService = require('../services/schwabService');
const sheetsService = require('../services/sheetsService');
const accountStore = require('../services/accountStore');

// syncHistory holds the last result for display in the app
const syncHistory = [];
const MAX_HISTORY = 50;

/**
 * Syncs all mapped accounts.
 * Called both by the cron scheduler and the manual sync endpoint.
 */
async function runScheduledSync() {
  const mappings = accountStore.getAllMappings();
  const accountIds = Object.keys(mappings);

  if (accountIds.length === 0) {
    console.log('[sync] No account mappings configured, skipping.');
    return { synced: 0 };
  }

  const results = [];

  for (const schwabAccountId of accountIds) {
    const { googleSheetId, sheetName, startCell } = mappings[schwabAccountId];
    const entry = {
      schwabAccountId,
      googleSheetId,
      sheetName,
      startCell,
      timestamp: new Date().toISOString(),
    };

    try {
      // Fetch all holdings from Schwab
      const allAccounts = await schwabService.getHoldings(schwabAccountId);

      // Find the specific account in the response
      const account = allAccounts.find(
        (a) => a.securitiesAccount?.accountNumber === schwabAccountId
      );

      if (!account) {
        throw new Error(`Account ${schwabAccountId} not found in Schwab response`);
      }

      const positions = account.securitiesAccount?.positions ?? [];

      // Write to Google Sheet using configured tab and start cell
      const result = await sheetsService.writeHoldingsToSheet(
        googleSheetId,
        positions,
        sheetName,
        startCell
      );

      entry.status = 'success';
      entry.updatedSymbols = result.updatedSymbols;
      entry.newSymbols = result.newSymbols;
      console.log(
        `[sync] ✓ Account ${schwabAccountId} → "${sheetName}"!${startCell}: ` +
        `${result.updatedSymbols} updated, ${result.newSymbols} new`
      );
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message;
      console.error(`[sync] ✗ Account ${schwabAccountId}: ${err.message}`);
    }

    results.push(entry);
    addToHistory(entry);
  }

  return { synced: results.length, results };
}

function addToHistory(entry) {
  syncHistory.unshift(entry);
  if (syncHistory.length > MAX_HISTORY) syncHistory.pop();
}

function getSyncHistory() {
  return syncHistory;
}

module.exports = { runScheduledSync, getSyncHistory };
