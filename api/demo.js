// Demo mode — returns realistic mock data when Supabase is not configured.
// Automatically active when SUPABASE_URL or SUPABASE_KEY is missing/placeholder.

const DEMO_PRODUCTS = [
  { part_number: 'ABC123', source: 'excel',    description: 'Brake Pad Front',   unit_price: 45.00, stock_qty: 50,  updated_at: new Date().toISOString() },
  { part_number: 'ABC123', source: 'manual',   description: 'Brake Pad Front',   unit_price: 48.00, stock_qty: 50,  updated_at: new Date().toISOString() },
  { part_number: 'XYZ456', source: 'excel',    description: 'Oil Filter',        unit_price: 25.00, stock_qty: 0,   updated_at: new Date().toISOString() },
  { part_number: 'DEF789', source: 'external', description: 'Air Filter',        unit_price: 35.00, stock_qty: 3,   updated_at: new Date().toISOString() },
  { part_number: 'GHI012', source: 'manual',   description: 'Wiper Blade 16"',   unit_price: 18.50, stock_qty: 2,   updated_at: new Date().toISOString() },
  { part_number: 'JKL345', source: 'excel',    description: 'Spark Plug NGK',    unit_price: 12.00, stock_qty: 100, updated_at: new Date().toISOString() },
  { part_number: 'MNO678', source: 'excel',    description: 'Engine Oil 5W-30',  unit_price: 55.00, stock_qty: 4,   updated_at: new Date().toISOString() },
];

const DEMO_LOOKUP = [
  { part_number: 'ABC123', description: 'Brake Pad Front',  unit_price: 45.00, stock_qty: 50,  source: 'excel' },
  { part_number: 'XYZ456', description: 'Oil Filter',       unit_price: 25.00, stock_qty: 0,   source: 'excel' },
  { part_number: 'DEF789', description: 'Air Filter',       unit_price: 35.00, stock_qty: 3,   source: 'external' },
  { part_number: 'GHI012', description: 'Wiper Blade 16"',  unit_price: 18.50, stock_qty: 2,   source: 'manual' },
  { part_number: 'JKL345', description: 'Spark Plug NGK',   unit_price: 12.00, stock_qty: 100, source: 'excel' },
  { part_number: 'MNO678', description: 'Engine Oil 5W-30', unit_price: 55.00, stock_qty: 4,   source: 'excel' },
];

const DEMO_CUSTOMERS = [
  { id: 'c1', name: 'Ahmad bin Razak', username: 'ahmad_r',  source: 'Telegram',  telegram_id: 111, created_at: daysAgo(1) },
  { id: 'c2', name: 'Lee Wei Jian',    username: 'weijian',  source: 'WhatsApp',  telegram_id: 222, created_at: daysAgo(3) },
  { id: 'c3', name: 'Siti Nurhaliza',  username: 'siti_n',   source: 'Telegram',  telegram_id: 333, created_at: daysAgo(5) },
  { id: 'c4', name: 'Rajan Pillai',    username: null,        source: 'Walk-in',   telegram_id: null, created_at: daysAgo(7) },
  { id: 'c5', name: 'Tan Ah Kow',      username: 'tahkow',   source: 'Referral',  telegram_id: 555, created_at: daysAgo(10) },
];

const DEMO_QUOTATIONS = [
  {
    id: 'q1', quote_number: 'QT-20260419-001', status: 'pending', total_amount: 115.00, has_tbd: false,
    created_at: daysAgo(0), follow_up_due: daysAgo(-2),
    customers: { name: 'Ahmad bin Razak', username: 'ahmad_r', source: 'Telegram', telegram_id: 111 },
    quotation_items: [
      { part_number: 'ABC123', description: 'Brake Pad Front', qty: 2, unit_price: 45.00, subtotal: 90.00, price_source: 'excel' },
      { part_number: 'XYZ456', description: 'Oil Filter',      qty: 1, unit_price: 25.00, subtotal: 25.00, price_source: 'excel' },
    ]
  },
  {
    id: 'q2', quote_number: 'QT-20260418-003', status: 'won', total_amount: 230.00, has_tbd: false,
    created_at: daysAgo(1), follow_up_due: daysAgo(3),
    customers: { name: 'Lee Wei Jian', username: 'weijian', source: 'WhatsApp', telegram_id: 222 },
    quotation_items: [
      { part_number: 'JKL345', description: 'Spark Plug NGK',   qty: 4, unit_price: 12.00, subtotal: 48.00,  price_source: 'excel' },
      { part_number: 'MNO678', description: 'Engine Oil 5W-30', qty: 3, unit_price: 55.00, subtotal: 165.00, price_source: 'excel' },
      { part_number: 'GHI012', description: 'Wiper Blade 16"',  qty: 1, unit_price: 18.50, subtotal: 18.50,  price_source: 'manual' },
    ]
  },
  {
    id: 'q3', quote_number: 'QT-20260417-002', status: 'pending', total_amount: 0, has_tbd: true,
    created_at: daysAgo(2), follow_up_due: daysAgo(0),
    customers: { name: 'Siti Nurhaliza', username: 'siti_n', source: 'Telegram', telegram_id: 333 },
    quotation_items: [
      { part_number: 'ZZZ999', description: 'ZZZ999', qty: 1, unit_price: null, subtotal: null, price_source: 'tbd' },
    ]
  },
  {
    id: 'q4', quote_number: 'QT-20260416-005', status: 'lost', total_amount: 89.00, has_tbd: false,
    created_at: daysAgo(3), follow_up_due: daysAgo(1),
    customers: { name: 'Rajan Pillai', username: null, source: 'Walk-in', telegram_id: null },
    quotation_items: [
      { part_number: 'DEF789', description: 'Air Filter', qty: 2, unit_price: 35.00, subtotal: 70.00, price_source: 'external' },
      { part_number: 'GHI012', description: 'Wiper Blade 16"', qty: 1, unit_price: 18.50, subtotal: 18.50, price_source: 'manual' },
    ]
  },
  {
    id: 'q5', quote_number: 'QT-20260415-001', status: 'won', total_amount: 45.00, has_tbd: false,
    created_at: daysAgo(4), follow_up_due: daysAgo(2),
    customers: { name: 'Tan Ah Kow', username: 'tahkow', source: 'Referral', telegram_id: 555 },
    quotation_items: [
      { part_number: 'ABC123', description: 'Brake Pad Front', qty: 1, unit_price: 45.00, subtotal: 45.00, price_source: 'excel' },
    ]
  },
];

const DEMO_PRICE_CHANGES = [
  { id: 'ph1', part_number: 'ABC123', source: 'excel', description: 'Brake Pad Front',   old_price: 42.00, new_price: 45.00, old_stock: 60, new_stock: 50, changed_at: daysAgo(2) },
  { id: 'ph2', part_number: 'MNO678', source: 'excel', description: 'Engine Oil 5W-30',  old_price: 58.00, new_price: 55.00, old_stock: 10, new_stock: 4,  changed_at: daysAgo(5) },
  { id: 'ph3', part_number: 'DEF789', source: 'external', description: 'Air Filter',     old_price: 32.00, new_price: 35.00, old_stock: 8,  new_stock: 3,  changed_at: daysAgo(7) },
];

const DEMO_SETTINGS = {
  ext_api_url: '',
  ext_api_key: '',
  ext_api_last_sync: '',
  ext_api_last_count: '',
  excel_last_filename: 'STOCK CLOSING 31-03-2026.xlsx',
  excel_last_import: daysAgo(2),
  excel_last_count: '6',
  low_stock_threshold: '5',
  ext_sync_interval: '',
};

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function isDemoMode() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_KEY || '';
  return !url || url.includes('your-project') || !key || key.includes('your_');
}

function demoRouter(app) {
  if (!isDemoMode()) return;

  console.log('⚡ DEMO MODE — using mock data (fill in .env to connect real database)');

  // Dashboard
  app.get('/api/dashboard/summary', (req, res) => {
    res.json({
      total: { today: 1, week: 3, month: 5, all: 5 },
      won: { count: 2, revenue: 275.00 },
      pending: { count: 2 },
      lost: { count: 1 },
      overdue_followups: 2,
      sources: [
        { source: 'Telegram', count: 3 },
        { source: 'WhatsApp', count: 1 },
        { source: 'Walk-in',  count: 1 },
        { source: 'Referral', count: 1 },
      ]
    });
  });

  app.get('/api/dashboard/price-changes', (req, res) => res.json(DEMO_PRICE_CHANGES));

  app.get('/api/dashboard/low-stock', (req, res) => {
    const threshold = parseInt(DEMO_SETTINGS.low_stock_threshold, 10) || 5;
    res.json({
      threshold,
      items: DEMO_LOOKUP.filter(p => p.stock_qty < threshold)
    });
  });

  // Quotations
  app.get('/api/quotations', (req, res) => {
    let data = [...DEMO_QUOTATIONS];
    if (req.query.status) data = data.filter(q => q.status === req.query.status);
    res.json(data);
  });

  app.get('/api/quotations/followups', (req, res) => {
    res.json(DEMO_QUOTATIONS.filter(q => q.status === 'pending'));
  });

  app.get('/api/quotations/:id', (req, res) => {
    const q = DEMO_QUOTATIONS.find(q => q.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'Not found' });
    res.json(q);
  });

  app.patch('/api/quotations/:id/status', (req, res) => {
    const q = DEMO_QUOTATIONS.find(q => q.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'Not found' });
    q.status = req.body.status;
    res.json(q);
  });

  app.patch('/api/quotations/:id/followup', (req, res) => {
    const q = DEMO_QUOTATIONS.find(q => q.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'Not found' });
    q.follow_up_due = req.body.follow_up_due;
    res.json(q);
  });

  // Customers
  app.get('/api/customers', (req, res) => res.json(DEMO_CUSTOMERS));
  app.get('/api/customers/sources', (req, res) => {
    res.json([
      { source: 'Telegram', count: 3 },
      { source: 'WhatsApp', count: 1 },
      { source: 'Walk-in',  count: 1 },
      { source: 'Referral', count: 1 },
    ]);
  });
  app.patch('/api/customers/:id/source', (req, res) => {
    const c = DEMO_CUSTOMERS.find(c => c.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    c.source = req.body.source;
    res.json(c);
  });

  // Products
  app.get('/api/products', (req, res) => {
    let data = [...DEMO_PRODUCTS];
    if (req.query.source) data = data.filter(p => p.source === req.query.source);
    res.json(data);
  });
  app.get('/api/products/lookup', (req, res) => res.json(DEMO_LOOKUP));
  app.post('/api/products', (req, res) => {
    const p = { ...req.body, source: 'manual', updated_at: new Date().toISOString() };
    DEMO_PRODUCTS.push(p);
    DEMO_LOOKUP.push(p);
    res.json(p);
  });
  app.put('/api/products/:part_number', (req, res) => {
    const idx = DEMO_PRODUCTS.findIndex(p => p.part_number === req.params.part_number && p.source === (req.body.source || 'manual'));
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    DEMO_PRODUCTS[idx] = { ...DEMO_PRODUCTS[idx], ...req.body, updated_at: new Date().toISOString() };
    res.json(DEMO_PRODUCTS[idx]);
  });
  app.delete('/api/products/:part_number', (req, res) => res.json({ success: true }));
  app.post('/api/products/import', (req, res) => {
    res.json({ imported: 6, total: 6, source: 'excel', filename: 'demo.xlsx', columns_detected: { part_number: 'Part No.', description: 'Description', unit_price: 'Unit Price', stock_qty: 'Stock' } });
  });
  app.post('/api/products/sync', (req, res) => {
    res.json({ synced: 3, total: 3, source: 'external' });
  });

  // Settings
  app.get('/api/settings', (req, res) => res.json(DEMO_SETTINGS));
  app.put('/api/settings', (req, res) => {
    Object.assign(DEMO_SETTINGS, req.body);
    res.json({ ok: true });
  });
  app.post('/api/settings/test-external', (req, res) => {
    res.json({ ok: true, count: 3, sample: DEMO_LOOKUP.slice(0, 2) });
  });
  app.post('/api/settings/reschedule', (req, res) => res.json({ ok: true }));

  // Remind
  app.post('/api/remind', (req, res) => res.json({ ok: true, demo: true }));
}

module.exports = { demoRouter, isDemoMode };
