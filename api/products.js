const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const supabase = require('../db/supabase');
const { getSetting } = require('./settings');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const SOURCES = ['excel', 'external', 'manual'];

// Log price/stock changes to price_history table
async function logPriceChanges(incoming, source) {
  if (!incoming || incoming.length === 0) return;

  const partNumbers = incoming.map(p => p.part_number);
  const { data: existing } = await supabase
    .from('products')
    .select('part_number, unit_price, stock_qty')
    .eq('source', source)
    .in('part_number', partNumbers);

  const existingMap = {};
  (existing || []).forEach(r => { existingMap[r.part_number] = r; });

  const changes = incoming
    .filter(p => {
      const prev = existingMap[p.part_number];
      if (!prev) return false; // new part, not a change
      return prev.unit_price !== p.unit_price || prev.stock_qty !== p.stock_qty;
    })
    .map(p => {
      const prev = existingMap[p.part_number];
      return {
        part_number: p.part_number,
        source,
        description: p.description,
        old_price: prev.unit_price,
        new_price: p.unit_price,
        old_stock: prev.stock_qty,
        new_stock: p.stock_qty,
        changed_at: new Date().toISOString()
      };
    });

  if (changes.length > 0) {
    await supabase.from('price_history').insert(changes);
  }
}

// GET all products (all sources) — returns raw rows grouped for dashboard
router.get('/', async (req, res) => {
  const { source } = req.query;
  let query = supabase.from('products').select('*').order('part_number').order('source');
  if (source && SOURCES.includes(source)) query = query.eq('source', source);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET effective price list (priority view) — for reference/preview
router.get('/lookup', async (req, res) => {
  const { data, error } = await supabase
    .from('price_lookup')
    .select('*')
    .order('part_number');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST create/update manual product
router.post('/', async (req, res) => {
  const { part_number, description, unit_price, stock_qty } = req.body;
  if (!part_number || !description) return res.status(400).json({ error: 'part_number and description required' });

  const { data, error } = await supabase
    .from('products')
    .upsert({
      part_number: part_number.toUpperCase(),
      source: 'manual',
      description,
      unit_price,
      stock_qty,
      updated_at: new Date().toISOString()
    }, { onConflict: 'part_number,source' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT update a specific product+source record
router.put('/:part_number', async (req, res) => {
  const { part_number } = req.params;
  const { source = 'manual', description, unit_price, stock_qty } = req.body;

  const { data, error } = await supabase
    .from('products')
    .update({ description, unit_price, stock_qty, updated_at: new Date().toISOString() })
    .eq('part_number', part_number.toUpperCase())
    .eq('source', source)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE a specific product+source record
router.delete('/:part_number', async (req, res) => {
  const { part_number } = req.params;
  const { source = 'manual' } = req.query;

  const { error } = await supabase
    .from('products')
    .delete()
    .eq('part_number', part_number.toUpperCase())
    .eq('source', source);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST upload Excel stock file → source = 'excel'
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    // Read as raw arrays — no assumptions about header row
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', header: 1 });
    if (!raw || raw.length < 2) return res.status(400).json({ error: 'Excel file is empty or too short' });

    const norm = s => String(s).toLowerCase().replace(/[\s_\-\.()#\/]/g, '');
    const PRICE_KW = ['price','harga','rate','cost','amt','sellingprice','unitprice','avgcost'];
    const STOCK_KW = ['stock','qty','quantity','onhand','baki','balance','qoh','bal'];
    // Removed 'no' / 'bil' — too broad; matches row-counter "No." column. Compound terms still work.
    const PART_KW  = ['part','itemcode','itemno','code','item'];
    const DESC_KW  = ['description','itemdesc','desc','keterangan','barang'];

    // Headers found multiple rows in; find first row with >= 3 named text cells (real header)
    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(raw.length, 30); i++) {
      const named = raw[i].filter(c => c && isNaN(c) && String(c).trim().length > 1);
      if (named.length >= 3) { headerRowIdx = i; break; }
    }
    // Fallback: if no "rich" header found, use the first row with ANY named cell
    if (headerRowIdx === 0 && raw[0].every(c => !c || String(c).trim().length <= 1)) {
      for (let i = 0; i < Math.min(raw.length, 30); i++) {
        const named = raw[i].filter(c => c && isNaN(c) && String(c).trim().length > 1);
        if (named.length >= 1) { headerRowIdx = i; break; }
      }
    }

    const headerRow = raw[headerRowIdx];
    const dataRows  = raw.slice(headerRowIdx + 1);

    // Data samples used to validate each detected column
    const samples = dataRows.slice(0, 40).filter(r => r.some(c => c !== ''));
    const looksLikePart = (ci) => {
      const vals = samples.map(r => String(r[ci] ?? '').trim()).filter(Boolean);
      if (!vals.length) return false;
      // Reject sequential row counters (1, 2, 3...)
      if (vals.every((v, i) => Number(v) === i + 1)) return false;
      // Reject pure-numeric column (price / qty / row#)
      const numCount = vals.filter(v => !isNaN(Number(v))).length;
      if (numCount / vals.length > 0.8) return false;
      return true;
    };

    let iPrice = -1, iStock = -1, iPart = -1, iDesc = -1;

    headerRow.forEach((h, i) => {
      const n = norm(h);
      if (!n) return;
      if (iPrice < 0 && PRICE_KW.some(k => n.includes(k))) iPrice = i;
      if (iStock < 0 && STOCK_KW.some(k => n.includes(k))) iStock = i;
      if (iPart  < 0 && PART_KW.some(k => n.includes(k))  && looksLikePart(i)) iPart = i;
      if (iDesc  < 0 && DESC_KW.some(k => n.includes(k))) iDesc = i;
    });

    // Step 3: if part/desc still not found, detect by data patterns
    if (iPart < 0 || iDesc < 0) {
      const samples = dataRows.slice(0, 30).filter(r => r.some(c => c !== ''));
      const colStats = headerRow.map((_, ci) => {
        const vals = samples.map(r => String(r[ci] ?? '').trim()).filter(v => v.length > 0);
        if (!vals.length) return { ci, avgLen: 0, isNum: true, isText: false };
        const avgLen = vals.reduce((s, v) => s + v.length, 0) / vals.length;
        // A value is numeric only if the whole trimmed string is a valid number (not just contains digits)
        const numCount = vals.filter(v => !isNaN(Number(v)) && v !== '').length;
        const isSeq = vals.every((v, i) => Number(v) === i + 1);
        const isNum  = numCount / vals.length > 0.8;
        const isText = !isNum && !isSeq && avgLen > 1;
        return { ci, avgLen, isNum, isText };
      });

      const textCols = colStats.filter(c => c.isText && c.ci !== iPrice && c.ci !== iStock);

      // Part number: leftmost text column (first meaningful identifier)
      if (iPart < 0 && textCols.length > 0) {
        iPart = textCols.reduce((a, b) => a.ci < b.ci ? a : b).ci;
      }

      // Description: text column with longest average content (excluding part col)
      if (iDesc < 0) {
        const candidate = textCols
          .filter(c => c.ci !== iPart)
          .sort((a, b) => b.avgLen - a.avgLen)[0];
        if (candidate) iDesc = candidate.ci;
      }
    }

    if (iPart < 0 || iDesc < 0) {
      return res.status(400).json({
        error: `Cannot detect Part Number or Description columns. Headers found: ${headerRow.filter(h => h).join(', ') || '(none)'}. Please add column headers to your Excel file.`
      });
    }

    const products = dataRows
      .map(row => ({
        part_number: String(row[iPart] ?? '').trim().toUpperCase(),
        source: 'excel',
        description: String(row[iDesc] ?? '').trim() || '-',
        unit_price: iPrice >= 0 ? (parseFloat(String(row[iPrice]).replace(/[^0-9.]/g, '')) || 0) : 0,
        stock_qty:  iStock >= 0 ? (parseInt(String(row[iStock]).replace(/[^0-9]/g, ''), 10) || 0) : 0,
        updated_at: new Date().toISOString()
      }))
      .filter(p => p.part_number && p.part_number.length > 1 && isNaN(p.part_number));

    // Log price changes before upserting
    await logPriceChanges(products, 'excel');

    // Batch upsert in chunks of 500
    let imported = 0;
    for (let i = 0; i < products.length; i += 500) {
      const chunk = products.slice(i, i + 500);
      const { data, error } = await supabase
        .from('products')
        .upsert(chunk, { onConflict: 'part_number,source' })
        .select();
      if (error) return res.status(500).json({ error: error.message });
      imported += data.length;
    }

    // Save import metadata to settings
    await supabase.from('settings').upsert([
      { key: 'excel_last_filename', value: req.file.originalname, updated_at: new Date().toISOString() },
      { key: 'excel_last_import', value: new Date().toISOString(), updated_at: new Date().toISOString() },
      { key: 'excel_last_count', value: String(imported), updated_at: new Date().toISOString() }
    ], { onConflict: 'key' });

    res.json({
      imported,
      total: products.length,
      source: 'excel',
      filename: req.file.originalname,
      columns_detected: {
        part_number: `col[${iPart}]`,
        description: `col[${iDesc}]`,
        unit_price: iPrice >= 0 ? `col[${iPrice}]` : '(not found, defaulted to 0)',
        stock_qty:  iStock >= 0 ? `col[${iStock}]` : '(not found, defaulted to 0)'
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to parse Excel file: ' + e.message });
  }
});

// POST batched import (client parsed Excel → JSON chunks)
// Avoids Vercel's 4.5 MB body limit for large spreadsheets
router.post('/import-batch', async (req, res) => {
  try {
    const { filename, products: incoming, first, finalize, total } = req.body || {};
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ error: 'No products in batch' });
    }

    const products = incoming
      .map(p => ({
        part_number: String(p.part_number || '').trim().toUpperCase(),
        source: 'excel',
        description: String(p.description || '').trim() || '-',
        unit_price: parseFloat(p.unit_price) || 0,
        stock_qty:  parseInt(p.stock_qty, 10) || 0,
        updated_at: new Date().toISOString()
      }))
      .filter(p => p.part_number && p.part_number.length > 1 && isNaN(p.part_number));

    await logPriceChanges(products, 'excel');

    let imported = 0;
    for (let i = 0; i < products.length; i += 500) {
      const chunk = products.slice(i, i + 500);
      const { data, error } = await supabase
        .from('products')
        .upsert(chunk, { onConflict: 'part_number,source' })
        .select();
      if (error) return res.status(500).json({ error: error.message });
      imported += data.length;
    }

    if (finalize) {
      await supabase.from('settings').upsert([
        { key: 'excel_last_filename', value: filename || '(uploaded)', updated_at: new Date().toISOString() },
        { key: 'excel_last_import',   value: new Date().toISOString(), updated_at: new Date().toISOString() },
        { key: 'excel_last_count',    value: String(total || imported), updated_at: new Date().toISOString() }
      ], { onConflict: 'key' });
    }

    res.json({ imported, finalize: !!finalize });
  } catch (e) {
    res.status(500).json({ error: 'Batch import failed: ' + e.message });
  }
});

// POST sync from external system → source = 'external'
router.post('/sync', async (req, res) => {
  // Read from DB settings first, fall back to .env
  const apiUrl = await getSetting('ext_api_url', 'EXT_API_URL');
  const apiKey = await getSetting('ext_api_key', 'EXT_API_KEY');

  if (!apiUrl) return res.status(400).json({ error: 'External API URL not configured. Set it in Settings tab.' });

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(apiUrl, { headers });
    if (!response.ok) throw new Error(`External API returned ${response.status}`);

    const externalData = await response.json();
    if (!Array.isArray(externalData)) throw new Error('External API must return a JSON array');

    const products = externalData
      .map(item => ({
        part_number: String(item.part_number || '').trim().toUpperCase(),
        source: 'external',
        description: String(item.description || '').trim() || '-',
        unit_price: parseFloat(item.unit_price) || 0,
        stock_qty: parseInt(item.stock_qty, 10) || 0,
        updated_at: new Date().toISOString()
      }))
      .filter(p => p.part_number);

    // Log price changes before upserting
    await logPriceChanges(products, 'external');

    let synced = 0;
    for (let i = 0; i < products.length; i += 500) {
      const chunk = products.slice(i, i + 500);
      const { data, error } = await supabase
        .from('products')
        .upsert(chunk, { onConflict: 'part_number,source' })
        .select();
      if (error) return res.status(500).json({ error: error.message });
      synced += data.length;
    }

    // Save sync metadata to settings
    await supabase.from('settings').upsert([
      { key: 'ext_api_last_sync', value: new Date().toISOString(), updated_at: new Date().toISOString() },
      { key: 'ext_api_last_count', value: String(synced), updated_at: new Date().toISOString() }
    ], { onConflict: 'key' });

    res.json({ synced, total: products.length, source: 'external' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
