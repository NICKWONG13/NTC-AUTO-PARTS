-- Run this in Supabase SQL Editor
-- If you already ran the previous version, run the migration at the bottom instead

-- 1. Products (price catalog) — composite PK: part_number + source
CREATE TABLE IF NOT EXISTS products (
  part_number TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('excel', 'external', 'manual')),
  description TEXT NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  stock_qty INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (part_number, source)
);

-- Priority view: excel > external > manual
-- Bot always queries this view to get the highest-priority price
CREATE OR REPLACE VIEW price_lookup AS
SELECT DISTINCT ON (part_number)
  part_number, description, unit_price, stock_qty, source, updated_at
FROM products
ORDER BY part_number,
  CASE source WHEN 'excel' THEN 1 WHEN 'external' THEN 2 WHEN 'manual' THEN 3 END;

-- 2. Customers (from Telegram)
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE,
  name TEXT,
  username TEXT,
  source TEXT NOT NULL DEFAULT 'Telegram',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Quotation headers
CREATE TABLE IF NOT EXISTS quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number TEXT UNIQUE NOT NULL,
  customer_id UUID REFERENCES customers(id),
  telegram_chat_id BIGINT,
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost')),
  has_tbd BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  follow_up_due TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '2 days'
);

-- 4. Quotation line items
CREATE TABLE IF NOT EXISTS quotation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  part_number TEXT,
  description TEXT NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  unit_price NUMERIC(10,2),
  subtotal NUMERIC(10,2),
  price_source TEXT  -- tracks which source provided the price: excel/external/manual/tbd
);

-- 5. App settings (key-value store for dashboard-configurable options)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default setting keys (values left empty — filled from dashboard)
INSERT INTO settings (key, value) VALUES
  ('ext_api_url', ''),
  ('ext_api_key', ''),
  ('ext_api_last_sync', ''),
  ('ext_api_last_count', ''),
  ('excel_last_filename', ''),
  ('excel_last_import', ''),
  ('excel_last_count', ''),
  ('low_stock_threshold', '5')
ON CONFLICT (key) DO NOTHING;

-- 6. Price change history (market movement tracking)
CREATE TABLE IF NOT EXISTS price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_number TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT,
  old_price NUMERIC(10,2),
  new_price NUMERIC(10,2),
  old_stock INT,
  new_stock INT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_history_part ON price_history(part_number);
CREATE INDEX IF NOT EXISTS idx_price_history_changed ON price_history(changed_at DESC);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_quotations_follow_up ON quotations(follow_up_due) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_quotations_created ON quotations(created_at);
CREATE INDEX IF NOT EXISTS idx_customers_telegram ON customers(telegram_id);
CREATE INDEX IF NOT EXISTS idx_items_quotation ON quotation_items(quotation_id);
CREATE INDEX IF NOT EXISTS idx_products_source ON products(source);

-- =============================================================
-- MIGRATION: if you already ran the OLD migration.sql, run this:
-- =============================================================
/*
ALTER TABLE products ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('excel','external','manual'));

-- Re-create primary key
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pkey;
ALTER TABLE products ADD PRIMARY KEY (part_number, source);

CREATE OR REPLACE VIEW price_lookup AS
SELECT DISTINCT ON (part_number)
  part_number, description, unit_price, stock_qty, source, updated_at
FROM products
ORDER BY part_number,
  CASE source WHEN 'excel' THEN 1 WHEN 'external' THEN 2 WHEN 'manual' THEN 3 END;

ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS price_source TEXT;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES
  ('ext_api_url', ''), ('ext_api_key', ''),
  ('ext_api_last_sync', ''), ('ext_api_last_count', ''),
  ('excel_last_filename', ''), ('excel_last_import', ''), ('excel_last_count', ''),
  ('low_stock_threshold', '5')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_number TEXT NOT NULL,
  source TEXT NOT NULL,
  description TEXT,
  old_price NUMERIC(10,2),
  new_price NUMERIC(10,2),
  old_stock INT,
  new_stock INT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_history_part ON price_history(part_number);
CREATE INDEX IF NOT EXISTS idx_price_history_changed ON price_history(changed_at DESC);

ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS price_source TEXT;
*/
