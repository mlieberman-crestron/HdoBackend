/**
 * services/portfolioAnalysisService.js
 *
 * Combines data from the HDO Portfolio Tracker Google Sheet with live Schwab quotes
 * to produce a per-security analysis grouped by Sector and Portfolio Section.
 *
 * Data flow:
 *   1. Read Symbol/Shares/AvgCost from "4 Holdings" (already kept current by sync)
 *   2. Read Sector/BuyUnder/Allocation/Risk from "2 HDO" and "3 Non-HDO" tabs
 *   3. Fetch live price + annual dividend from Schwab market data API
 *   4. Calculate yield, value, buy signal, blended max allocation
 *   5. Group and sort by sector → portfolio section → symbol
 */

const { readHoldingsFromSheet, readPortfolioMetadata } = require('./sheetsService');
const { getQuotes } = require('./schwabService');

/**
 * Blended max allocation: if min === max use that; otherwise min + 80% of the range.
 */
function blendAlloc(minAlloc, maxAlloc) {
  if (!minAlloc && !maxAlloc) return null;
  if (minAlloc === maxAlloc) return minAlloc;
  return minAlloc + (maxAlloc - minAlloc) * 0.8;
}

async function getPortfolioAnalysis(spreadsheetId, sheetName, startCell) {
  // Run sheet reads in parallel — they're independent
  const [holdings, securities] = await Promise.all([
    readHoldingsFromSheet(spreadsheetId, sheetName, startCell),
    readPortfolioMetadata(spreadsheetId),
  ]);

  // Build symbol → holding lookup
  const holdingsMap = {};
  for (const h of holdings) {
    if (h.symbol) holdingsMap[h.symbol] = h;
  }

  // Fetch live quotes for all tickers
  const symbols = securities.map((s) => s.symbol);
  const quotes = await getQuotes(symbols);

  // Build per-security rows
  const rows = securities.map((sec) => {
    const quote = quotes[sec.symbol] ?? {};
    const holding = holdingsMap[sec.symbol] ?? {};

    const price = quote.price;
    const annualDividend = quote.annualDividend;

    // Yield: prefer derived from annualDividend/price; fall back to Schwab's dividendYield field
    let yieldPct = null;
    if (price && annualDividend) {
      yieldPct = annualDividend / price;
    } else if (quote.dividendYield != null) {
      yieldPct = quote.dividendYield / 100; // Schwab returns as percent (e.g. 6.5 = 6.5%)
    }

    const shares = holding.quantity ?? 0;
    const avgCost = holding.averagePrice ?? 0;
    const currentValue = shares > 0 && price != null ? shares * price : null;
    const costBasis = shares > 0 && avgCost > 0 ? shares * avgCost : null;
    const gainLoss = currentValue != null && costBasis != null ? currentValue - costBasis : null;

    const maxAllocBlended = blendAlloc(sec.minAlloc, sec.maxAlloc);
    const buySignal = price != null && sec.buyUnder != null ? price < sec.buyUnder : false;

    return {
      symbol: sec.symbol,
      name: sec.name,
      sector: sec.sector || 'Unknown',
      portfolioSection: sec.portfolioSection || '',
      risk: sec.risk,
      source: sec.source,
      // Live market data
      price,
      annualDividend,
      yieldPct,
      // Holdings (from "4 Holdings" via sync)
      shares,
      avgCost: avgCost > 0 ? avgCost : null,
      currentValue,
      costBasis,
      gainLoss,
      // Strategy metadata (from "2 HDO" / "3 Non-HDO")
      buyUnder: sec.buyUnder,
      buySignal,
      minAlloc: sec.minAlloc,
      maxAlloc: sec.maxAlloc,
      maxAllocBlended,
    };
  });

  // Sort: sector → portfolioSection → symbol
  rows.sort((a, b) => {
    const s = a.sector.localeCompare(b.sector);
    if (s !== 0) return s;
    const p = a.portfolioSection.localeCompare(b.portfolioSection);
    if (p !== 0) return p;
    return a.symbol.localeCompare(b.symbol);
  });

  // Build sector summary
  const sectorMap = {};
  for (const row of rows) {
    if (!sectorMap[row.sector]) sectorMap[row.sector] = { count: 0, totalValue: 0 };
    sectorMap[row.sector].count += 1;
    sectorMap[row.sector].totalValue += row.currentValue ?? 0;
  }
  const sectorSummary = Object.entries(sectorMap)
    .map(([sector, s]) => ({ sector, ...s }))
    .sort((a, b) => b.totalValue - a.totalValue);

  const totalValue = rows.reduce((sum, r) => sum + (r.currentValue ?? 0), 0);

  return {
    rows,
    sectorSummary,
    totalValue,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getPortfolioAnalysis };
