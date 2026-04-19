const express = require('express');
const supabase = require('../db/supabase');

const router = express.Router();

// GET all quotations (with pagination + filter)
router.get('/', async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;

  let query = supabase
    .from('quotations')
    .select(`
      id, quote_number, total_amount, status, has_tbd,
      created_at, follow_up_due,
      customers(name, username, source),
      quotation_items(part_number, description, qty, unit_price, subtotal)
    `)
    .order('created_at', { ascending: false })
    .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET overdue follow-ups (must be before /:id)
router.get('/followups', async (req, res) => {
  const { data, error } = await supabase
    .from('quotations')
    .select(`
      id, quote_number, total_amount, has_tbd,
      created_at, follow_up_due, telegram_chat_id,
      customers(name, username, telegram_id)
    `)
    .eq('status', 'pending')
    .lt('follow_up_due', new Date().toISOString())
    .order('follow_up_due', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET single quotation by id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('quotations')
    .select(`
      id, quote_number, total_amount, status, has_tbd,
      created_at, follow_up_due, notes,
      customers(name, username, source, telegram_id),
      quotation_items(part_number, description, qty, unit_price, subtotal, price_source)
    `)
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// PATCH update status
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;

  if (!['pending', 'won', 'lost'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const { data, error } = await supabase
    .from('quotations')
    .update({ status, notes })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH update follow_up_due date
router.patch('/:id/followup', async (req, res) => {
  const { id } = req.params;
  const { follow_up_due } = req.body;

  const { data, error } = await supabase
    .from('quotations')
    .update({ follow_up_due })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
