// One-shot migration: copies all local JSON data to Supabase.
// Usage: node scripts/migrate-to-supabase.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;
if (!url || !key) { console.error('❌ SUPABASE_URL or SUPABASE_KEY not set'); process.exit(1); }

const supabase = createClient(url, key);
const DATA = path.join(__dirname, '..', 'db', 'local');

function load(name) {
  const f = path.join(DATA, `${name}.json`);
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

async function upsertChunked(table, rows, onConflict) {
  if (!rows.length) { console.log(`  (skip ${table} — 0 rows)`); return 0; }
  let total = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const q = supabase.from(table).upsert(chunk, onConflict ? { onConflict } : undefined);
    const { data, error } = await q.select();
    if (error) { console.error(`  ❌ ${table} error:`, error.message); return total; }
    total += data.length;
    process.stdout.write(`\r  ${table}: ${total}/${rows.length}`);
  }
  process.stdout.write('\n');
  return total;
}

(async () => {
  console.log('\n🚀 Migrating local data to Supabase…\n');

  // 1. Settings
  const settings = load('settings').map(s => ({
    key: s.key,
    value: s.value || '',
    updated_at: s.updated_at || new Date().toISOString()
  }));
  console.log('① Settings');
  await upsertChunked('settings', settings, 'key');

  // 2. Products (strip id — products uses composite PK part_number+source)
  const products = load('products').map(({ id, ...rest }) => rest);
  console.log('② Products');
  await upsertChunked('products', products, 'part_number,source');

  // 3. Customers
  const customers = load('customers');
  console.log('③ Customers');
  await upsertChunked('customers', customers, 'id');

  // 4. Quotations
  const quotations = load('quotations');
  console.log('④ Quotations');
  await upsertChunked('quotations', quotations, 'id');

  // 5. Quotation items
  const items = load('quotation_items');
  console.log('⑤ Quotation items');
  await upsertChunked('quotation_items', items, 'id');

  // 6. Price history
  const history = load('price_history');
  console.log('⑥ Price history');
  await upsertChunked('price_history', history, 'id');

  console.log('\n✅ Migration complete!');
})().catch(e => { console.error('\n❌ FAILED:', e.message); process.exit(1); });
