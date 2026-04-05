require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const authRoutes    = require('./routes/auth');
const schwabRoutes  = require('./routes/schwab');
const syncRoutes    = require('./routes/sync');
const accountRoutes = require('./routes/accounts');
const { runScheduledSync } = require('./jobs/syncJob');
const { proactiveRefresh } = require('./services/schwabService');

const app = express();

app.use(cors());
app.use(express.json());
app.use((req, res, next) => { res.setHeader('ngrok-skip-browser-warning', 'true'); next(); });

// Routes
app.use('/auth',     authRoutes);
app.use('/schwab',   schwabRoutes);
app.use('/sync',     syncRoutes);
app.use('/accounts', accountRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Refresh Schwab token every 20 minutes so it never expires mid-session
setInterval(async () => {
  try { await proactiveRefresh(); } catch { /* logged inside */ }
}, 20 * 60 * 1000);

// Daily cron — runs at configured time (default 6am)
const cronTime = process.env.SYNC_CRON || '0 6 * * 1-5';
cron.schedule(cronTime, async () => {
  console.log('[cron] Running scheduled sync...');
  try {
    await runScheduledSync();
  } catch (err) {
    console.error('[cron] Sync failed:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HDO Sync backend running on http://localhost:${PORT}`);
  console.log(`Scheduled sync: ${cronTime}`);
});
