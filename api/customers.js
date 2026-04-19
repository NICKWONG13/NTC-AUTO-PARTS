const express = require('express');
const supabase = require('../db/supabase');

const router = express.Router();

// GET all customers
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, username, source, telegram_id, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET source breakdown
router.get('/sources', async (req, res) => {
  const { data, error } = await supabase
    .from('customers')
    .select('source');
  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  data.forEach(c => {
    counts[c.source] = (counts[c.source] || 0) + 1;
  });
  res.json(Object.entries(counts).map(([source, count]) => ({ source, count })));
});

// PATCH update customer source
router.patch('/:id/source', async (req, res) => {
  const { id } = req.params;
  const { source } = req.body;
  const { data, error } = await supabase
    .from('customers')
    .update({ source })
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
