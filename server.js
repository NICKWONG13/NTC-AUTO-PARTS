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
// Serverless (Vercel) must use webhook. Local/dev uses polling.
const isServerless = !!process.env.VERCEL || process.env.NODE_ENV === 'production';

if (process.env.TELEGRAM_TOKEN) {
  if (isServerless) {
    bot = new TelegramBot(process.env.TELEGRAM_TOKEN);
    // Token split avoids Express treating the ":" as a route parameter
    const [botId, botSecret] = process.env.TELEGRAM_TOKEN.split(':');
    app.post(`/webhook/${botId}/${botSecret}`, (req, res) => {
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

// ─── Cron + listen — only on long-running server, NOT on Vercel serverless ───
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

app.post('/api/settings/reschedule', async (req, res) => {
  if (process.env.VERCEL) return res.json({ ok: true, note: 'Use Vercel Cron for scheduling' });
  await scheduleExternalSync();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

// Only listen + schedule crons when NOT on Vercel (Vercel uses the exported app)
if (!process.env.VERCEL) {
  cron.schedule('0 1 * * *', () => {
    if (bot && process.env.SALES_CHAT_ID) {
      sendFollowUpReminder(bot, process.env.SALES_CHAT_ID);
    }
  });

  app.listen(PORT, async () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}\n`);
    try { await scheduleExternalSync(); } catch (_) {}
  });
}

module.exports = app;
