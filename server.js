require('dotenv').config();
const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const { setupHandler, sendFollowUpReminder } = require('./bot/handler');
const supabase = require('./db/supabase');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/products', require('./api/products'));
app.use('/api/quotations', require('./api/quotations'));
app.use('/api/customers', require('./api/customers'));
app.use('/api/dashboard', require('./api/dashboard'));
app.use('/api/settings', require('./api/settings'));

// Manual follow-up reminder trigger from dashboard
app.post('/api/remind', async (req, res) => {
  if (!bot) return res.status(503).json({ error: 'Bot not ready' });
  await sendFollowUpReminder(bot, process.env.SALES_CHAT_ID);
  res.json({ ok: true });
});

// ─── Telegram bot ─────────────────────────────────────────────────────────────
let bot;
const isProduction = process.env.NODE_ENV === 'production';

if (process.env.TELEGRAM_TOKEN) {
  if (isProduction) {
    bot = new TelegramBot(process.env.TELEGRAM_TOKEN);
    app.post(`/webhook/${process.env.TELEGRAM_TOKEN}`, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
    console.log('Telegram bot in webhook mode');
  } else {
    bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
    console.log('Telegram bot in polling mode');
  }
  setupHandler(bot);
} else {
  console.warn('⚠️  TELEGRAM_TOKEN not set — bot disabled. Fill in .env to enable.');
}

// ─── Cron jobs ────────────────────────────────────────────────────────────────

// Daily follow-up reminder at 9am Malaysia time (01:00 UTC)
cron.schedule('0 1 * * *', () => {
  if (bot && process.env.SALES_CHAT_ID) {
    sendFollowUpReminder(bot, process.env.SALES_CHAT_ID);
  }
});

// Dynamic external sync — reads interval from DB settings at runtime
let externalSyncJob = null;

async function scheduleExternalSync() {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'ext_sync_interval')
    .single();

  const hours = parseInt(data?.value, 10);

  if (externalSyncJob) {
    externalSyncJob.stop();
    externalSyncJob = null;
  }

  if (hours && hours > 0) {
    // Build a cron expression: every N hours
    const cronExpr = `0 */${hours} * * *`;
    externalSyncJob = cron.schedule(cronExpr, async () => {
      console.log(`[auto-sync] Syncing external prices (every ${hours}h)…`);
      try {
        const res = await fetch(`http://localhost:${PORT}/api/products/sync`, { method: 'POST' });
        const json = await res.json();
        console.log(`[auto-sync] Done — ${json.synced} records`);
      } catch (e) {
        console.error('[auto-sync] Failed:', e.message);
      }
    });
    console.log(`External price auto-sync scheduled every ${hours}h`);
  }
}

// Re-read sync interval whenever settings change via API
// (called from api/settings.js after a successful PUT that includes ext_sync_interval)
app.post('/api/settings/reschedule', async (req, res) => {
  await scheduleExternalSync();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 Server running at http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}\n`);

  // Schedule external sync based on saved DB setting
  try { await scheduleExternalSync(); } catch (_) {}
});

module.exports = app;
