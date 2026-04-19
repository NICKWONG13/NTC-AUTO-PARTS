// Run: node scripts/check.js
// Verifies .env and Supabase connection before starting the server.

require('dotenv').config();

const REQUIRED = ['TELEGRAM_TOKEN', 'SALES_CHAT_ID', 'SUPABASE_URL', 'SUPABASE_KEY'];
const EXPECTED_TABLES = ['products', 'customers', 'quotations', 'quotation_items', 'settings', 'price_history'];

let pass = true;

function ok(msg)   { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); pass = false; }

async function run() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  NTC Auto Parts — Setup Check');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1. Check .env variables
  console.log('① Environment Variables:');
  for (const key of REQUIRED) {
    const val = process.env[key];
    if (!val || val.includes('your_') || val === '') {
      fail(`${key} — not set (edit your .env file)`);
    } else {
      ok(`${key} — set`);
    }
  }

  // 2. Check Supabase connection + tables
  console.log('\n② Supabase Connection:');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    fail('Cannot check Supabase — URL or KEY missing');
  } else {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

      for (const table of EXPECTED_TABLES) {
        const { error } = await supabase.from(table).select('*').limit(1);
        if (error) {
          if (error.code === '42P01') {
            fail(`Table "${table}" not found — run db/migration.sql in Supabase`);
          } else {
            fail(`Table "${table}" error: ${error.message}`);
          }
        } else {
          ok(`Table "${table}" — OK`);
        }
      }

      // Check price_lookup view
      const { error: viewErr } = await supabase.from('price_lookup').select('*').limit(1);
      if (viewErr) {
        fail(`View "price_lookup" not found — run db/migration.sql`);
      } else {
        ok(`View "price_lookup" — OK`);
      }

    } catch (e) {
      fail(`Supabase connection failed: ${e.message}`);
    }
  }

  // 3. Check Telegram token format
  console.log('\n③ Telegram Bot:');
  const token = process.env.TELEGRAM_TOKEN || '';
  if (/^\d+:[A-Za-z0-9_-]{35,}$/.test(token)) {
    ok('TELEGRAM_TOKEN format looks valid');
  } else if (token) {
    warn('TELEGRAM_TOKEN format looks unusual — double-check with @BotFather');
  }

  if (process.env.SALES_CHAT_ID && /^-?\d+$/.test(process.env.SALES_CHAT_ID)) {
    ok(`SALES_CHAT_ID — ${process.env.SALES_CHAT_ID}`);
  } else if (process.env.SALES_CHAT_ID) {
    warn('SALES_CHAT_ID should be a number (get it from @userinfobot in Telegram)');
  }

  // 4. Summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (pass) {
    console.log('  🎉 All checks passed! Run: npm run dev\n');
  } else {
    console.log('  ⚠️  Fix the issues above, then run: node scripts/check.js\n');
    process.exit(1);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
