const express = require('express');
const supabase = require('../db/supabase');

const router = express.Router();

function startOf(unit) {
  const now = new Date();
  if (unit === 'day') {
    now.setHours(0, 0, 0, 0);
  } else if (unit === 'week') {
    const day = now.getDay();
    now.setDate(now.getDate() - day);
    now.setHours(0, 0, 0, 0);
  } else if (unit === 'month') {
    now.setDate(1);
    now.setHours(0, 0, 0, 0);
  }
  return now.toISOString();
}

// GET summary stats
router.get('/summary', async (req, res) => {
  try {
    const [allQuotes, sources, overdueFollowups] = await Promise.all([
      supabase.from('quotations').select('status, total_amount, created_at, has_tbd'),
      supabase.from('customers').select('source'),
      supabase.from('quotations')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending')
        .lt('follow_up_due', new Date().toISOString())
    ]);

    const quotes = allQuotes.data || [];
    const today = startOf('day');
    const week = startOf('week');
    const month = startOf('month');

    const summary = {
      total: { today: 0, week: 0, month: 0, all: quotes.length },
      won: { count: 0, revenue: 0 },
      pending: { count: 0 },
      lost: { count: 0 },
      overdue_followups: overdueFollowups.count || 0
    };

    quotes.forEach(q => {
      if (q.created_at >= today) summary.total.today++;
      if (q.created_at >= week) summary.total.week++;
      if (q.created_at >= month) summary.total.month++;

      if (q.status === 'won') {
        summary.won.count++;
        summary.won.revenue += parseFloat(q.total_amount) || 0;
      } else if (q.status === 'pending') {
        summary.pending.count++;
      } else if (q.status === 'lost') {
        summary.lost.count++;
      }
    });

    const sourceCounts = {};
    (sources.data || []).forEach(c => {
      sourceCounts[c.source] = (sourceCounts[c.source] || 0) + 1;
    });
    summary.sources = Object.entries(sourceCounts).map(([source, count]) => ({ source, count }));

    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET recent price changes (last 30 days, up to 50 records)
router.get('/price-changes', async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('price_history')
      .select('*')
      .gte('changed_at', since)
      .order('changed_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET low-stock parts (uses threshold from settings, default 5)
router.get('/low-stock', async (req, res) => {
  try {
    const { data: setting } = await supabase
      .from('settings').select('value').eq('key', 'low_stock_threshold').single();
    const threshold = parseInt(setting?.value, 10) || 5;

    // Query the priority view so we get the effective stock per part
    const { data, error } = await supabase
      .from('price_lookup')
      .select('part_number, description, stock_qty, source, unit_price')
      .lt('stock_qty', threshold)
      .gt('stock_qty', -1)   // exclude negative (data errors)
      .order('stock_qty', { ascending: true })
      .limit(30);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ threshold, items: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
