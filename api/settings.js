const express = require('express');
const supabase = require('../db/supabase');

const router = express.Router();

// GET all settings as a flat object { key: value }
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('key, value');
  if (error) return res.status(500).json({ error: error.message });

  const obj = {};
  (data || []).forEach(row => { obj[row.key] = row.value || ''; });
  res.json(obj);
});

// PUT upsert one or more settings  { ext_api_url: '...', ext_api_key: '...' }
router.put('/', async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Body must be a JSON object' });

  const rows = Object.entries(updates).map(([key, value]) => ({
    key,
    value: String(value ?? ''),
    updated_at: new Date().toISOString()
  }));

  const { error } = await supabase
    .from('settings')
    .upsert(rows, { onConflict: 'key' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/settings/test-external — test connection without saving or syncing data
router.post('/test-external', async (req, res) => {
  const { url, key } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Server responded with ${response.status} ${response.statusText}`);

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Response is not a JSON array — expected [{part_number, description, unit_price, stock_qty}, …]');

    const sample = data.slice(0, 3);
    res.json({ ok: true, count: data.length, sample });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Helper used by other API files to read a single setting
// Falls back to process.env if DB value is empty
async function getSetting(key, envFallback = '') {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .single();
  return (data?.value && data.value.trim()) ? data.value.trim() : (process.env[envFallback] || '');
}

module.exports = router;
module.exports.getSetting = getSetting;
