const express = require('express');
const supabase = require('../db/supabase');

const router = express.Router();

async function getSetting(key, fallback) {
  const { data } = await supabase.from('settings').select('value').eq('key', key).single();
  return data?.value || fallback;
}

async function generatePONumber() {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `PO-${dateStr}-`;
  const { data } = await supabase
    .from('purchase_orders')
    .select('po_number')
    .like('po_number', `${prefix}%`)
    .order('po_number', { ascending: false })
    .limit(1);
  let seq = 1;
  if (data && data.length) seq = parseInt(data[0].po_number.split('-')[2], 10) + 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

// ─── GET /api/purchase-orders/basket — auto-generated low-stock list ──────
router.get('/basket', async (req, res) => {
  try {
    const threshold = parseInt(await getSetting('po_reorder_threshold', '2'), 10);
    const defaultQty = parseInt(await getSetting('po_reorder_qty', '10'), 10);
    const dismissedRaw = await getSetting('po_dismissed', '');
    const dismissed = new Set((dismissedRaw || '').split(',').map(s => s.trim()).filter(Boolean));

    const { data, error } = await supabase
      .from('price_lookup')
      .select('part_number, description, unit_price, stock_qty, source')
      .lt('stock_qty', threshold)
      .order('stock_qty', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    // Exclude parts already in an open (draft/sent) PO
    const { data: openItems } = await supabase
      .from('purchase_order_items')
      .select('part_number, po_id, purchase_orders!inner(status)')
      .in('purchase_orders.status', ['draft', 'sent']);
    const blocked = new Set((openItems || []).map(r => r.part_number));

    const items = (data || [])
      .filter(r => !blocked.has(r.part_number) && !dismissed.has(r.part_number))
      .map(r => ({
        part_number: r.part_number,
        description: r.description,
        current_stock: r.stock_qty,
        suggested_qty: Math.max(defaultQty - r.stock_qty, 1),
        unit_cost: r.unit_price,
        source: r.source
      }));

    res.json({ threshold, default_reorder_qty: defaultQty, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/purchase-orders/basket/dismiss — remove an item from basket ─
router.post('/basket/dismiss', async (req, res) => {
  try {
    const { part_number } = req.body || {};
    if (!part_number) return res.status(400).json({ error: 'part_number required' });

    // If it's a customer-requested placeholder (manual source, [REQUESTED] prefix),
    // delete it. Otherwise add to dismissed list.
    const { data: manual } = await supabase
      .from('products')
      .select('part_number, description, source')
      .eq('part_number', part_number)
      .eq('source', 'manual')
      .maybeSingle();

    if (manual && (manual.description || '').startsWith('[REQUESTED]')) {
      await supabase.from('products').delete()
        .eq('part_number', part_number).eq('source', 'manual');
      return res.json({ ok: true, action: 'deleted_request' });
    }

    // Append to dismissed list in settings
    const dismissedRaw = await getSetting('po_dismissed', '');
    const list = new Set((dismissedRaw || '').split(',').map(s => s.trim()).filter(Boolean));
    list.add(part_number);
    await supabase.from('settings').upsert({
      key: 'po_dismissed',
      value: [...list].join(','),
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    res.json({ ok: true, action: 'dismissed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/purchase-orders/basket/restore — clear dismissed list ─────
router.post('/basket/restore', async (req, res) => {
  try {
    await supabase.from('settings').upsert({
      key: 'po_dismissed', value: '', updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/purchase-orders — list all POs ─────────────────────────────
router.get('/', async (req, res) => {
  const { status } = req.query;
  let q = supabase.from('purchase_orders').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── GET /api/purchase-orders/:id — detailed PO with items ───────────────
router.get('/:id', async (req, res) => {
  const { data: po, error } = await supabase
    .from('purchase_orders').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  const { data: items } = await supabase
    .from('purchase_order_items').select('*').eq('po_id', po.id).order('created_at');
  res.json({ ...po, items: items || [] });
});

// ─── POST /api/purchase-orders — create a new PO from items ──────────────
router.post('/', async (req, res) => {
  try {
    const { items = [], supplier, notes } = req.body;
    if (!items.length) return res.status(400).json({ error: 'No items provided' });

    const total = items.reduce((s, i) => s + (parseFloat(i.unit_cost) || 0) * (parseInt(i.qty, 10) || 1), 0);
    const po_number = await generatePONumber();

    const { data: po, error } = await supabase
      .from('purchase_orders')
      .insert({ po_number, status: 'draft', total_amount: total, supplier, notes })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });

    const rows = items.map(i => ({
      po_id: po.id,
      part_number: i.part_number,
      description: i.description || null,
      qty: parseInt(i.qty, 10) || 1,
      unit_cost: parseFloat(i.unit_cost) || 0,
      subtotal: (parseFloat(i.unit_cost) || 0) * (parseInt(i.qty, 10) || 1),
      current_stock: i.current_stock ?? null
    }));
    await supabase.from('purchase_order_items').insert(rows);

    res.json({ ...po, items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /api/purchase-orders/:id/status — update status ───────────────
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['draft', 'sent', 'received', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const updates = { status };
  if (status === 'sent')     updates.sent_at     = new Date().toISOString();
  if (status === 'received') updates.received_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('purchase_orders').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // When received, top up stock for manual-source items (we don't touch excel/external)
  if (status === 'received') {
    const { data: items } = await supabase
      .from('purchase_order_items').select('*').eq('po_id', req.params.id);
    for (const item of items || []) {
      const { data: existing } = await supabase
        .from('products')
        .select('stock_qty')
        .eq('part_number', item.part_number)
        .eq('source', 'manual')
        .single();

      const newStock = (existing?.stock_qty || 0) + item.qty;
      await supabase.from('products').upsert({
        part_number: item.part_number,
        source: 'manual',
        description: item.description || item.part_number,
        unit_price: item.unit_cost || 0,
        stock_qty: newStock,
        updated_at: new Date().toISOString()
      }, { onConflict: 'part_number,source' });
    }
  }
  res.json(data);
});

// ─── DELETE /api/purchase-orders/:id ─────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('purchase_orders').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
