// Local file-based database — mimics Supabase client API using JSON files.
// Active when SUPABASE_URL / SUPABASE_KEY are missing or still placeholder.

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'local');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULTS = {
  settings: [
    { key: 'ext_api_url',        value: '' },
    { key: 'ext_api_key',        value: '' },
    { key: 'ext_api_last_sync',  value: '' },
    { key: 'ext_api_last_count', value: '' },
    { key: 'excel_last_filename',value: '' },
    { key: 'excel_last_import',  value: '' },
    { key: 'excel_last_count',   value: '' },
    { key: 'low_stock_threshold',value: '5' },
    { key: 'ext_sync_interval',  value: '' },
  ],
  products:        [],
  customers:       [],
  quotations:      [],
  quotation_items: [],
  price_history:   [],
};

// Default column values per table (mirrors Postgres DEFAULT expressions)
const TABLE_DEFAULTS = {
  quotations:    () => ({ created_at: new Date().toISOString(), follow_up_due: new Date(Date.now() + 2*86400000).toISOString(), status: 'pending', has_tbd: false, total_amount: 0 }),
  customers:     () => ({ created_at: new Date().toISOString(), source: 'Telegram' }),
  price_history: () => ({ changed_at: new Date().toISOString() }),
};

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function loadTable(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    const d = DEFAULTS[name] || [];
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
    return JSON.parse(JSON.stringify(d));
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveTable(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

// price_lookup VIEW logic: excel > external > manual per part_number
function getPriceLookup() {
  const priority = { excel: 1, external: 2, manual: 3 };
  const products  = loadTable('products');
  const best      = {};
  products.forEach(p => {
    const ex = best[p.part_number];
    if (!ex || priority[p.source] < priority[ex.source]) best[p.part_number] = p;
  });
  return Object.values(best).sort((a, b) => a.part_number.localeCompare(b.part_number));
}

// Parse supabase-style select string to find embedded relations
// e.g. "id, quote_number, customers(name, username), quotation_items(part_number, qty)"
function parseSelect(cols) {
  if (!cols || cols === '*') return { plain: null, relations: {} };
  const relations = {};
  // Replace relation syntax but keep the table name so pickCols includes it
  const plain = cols.replace(/(\w+)\(([^)]+)\)/g, (_, tbl, fields) => {
    relations[tbl] = fields.split(',').map(s => s.trim());
    return tbl; // keep relation key so pickCols passes it through
  }).split(',').map(s => s.trim()).filter(Boolean);
  return { plain: plain.length ? plain : null, relations };
}

function pickCols(row, cols) {
  if (!cols) return row;
  const out = {};
  cols.forEach(c => { out[c] = row[c]; });
  return out;
}

function resolveRelations(rows, relations) {
  if (!Object.keys(relations).length) return rows;
  return rows.map(row => {
    const r = { ...row };
    if (relations.customers) {
      const c = loadTable('customers').find(x => x.id === row.customer_id) || null;
      r.customers = c ? pickCols(c, relations.customers) : null;
    }
    if (relations.quotation_items) {
      const items = loadTable('quotation_items').filter(x => x.quotation_id === row.id);
      r.quotation_items = items.map(i => pickCols(i, relations.quotation_items));
    }
    return r;
  });
}

function cmpDate(a, b) {
  const da = new Date(a), db = new Date(b);
  return (!isNaN(da) && !isNaN(db)) ? [da, db] : null;
}

class QueryBuilder {
  constructor(tbl) {
    this._tbl      = tbl;
    this._isView   = tbl === 'price_lookup';
    this._filters  = [];
    this._order    = [];
    this._limit    = null;
    this._rangeFrom= null;
    this._rangeTo  = null;
    this._single   = false;
    this._head     = false;
    this._countMode= null;
    this._cols     = '*';
    this._op       = null; // 'insert'|'upsert'|'update'|'delete'
    this._payload  = null;
    this._upsertOpts = {};
  }

  select(cols = '*', opts = {}) {
    this._cols = cols;
    if (opts.count) this._countMode = opts.count;
    if (opts.head)  this._head      = true;
    return this;
  }
  insert(data)            { this._op = 'insert'; this._payload = Array.isArray(data) ? data : [data]; return this; }
  upsert(data, opts = {}) { this._op = 'upsert'; this._payload = Array.isArray(data) ? data : [data]; this._upsertOpts = opts; return this; }
  update(data)            { this._op = 'update'; this._payload = data; return this; }
  delete()                { this._op = 'delete'; return this; }
  eq(col, val)   { this._filters.push({ t: 'eq',   col, val });  return this; }
  in(col, vals)  { this._filters.push({ t: 'in',   col, vals }); return this; }
  lt(col, val)   { this._filters.push({ t: 'lt',   col, val });  return this; }
  gt(col, val)   { this._filters.push({ t: 'gt',   col, val });  return this; }
  gte(col, val)  { this._filters.push({ t: 'gte',  col, val });  return this; }
  lte(col, val)  { this._filters.push({ t: 'lte',  col, val });  return this; }
  like(col, val) { this._filters.push({ t: 'like', col, val });  return this; }
  ilike(col, val){ this._filters.push({ t: 'like', col, val });  return this; }
  order(col, opts = {}) { this._order.push({ col, asc: opts.ascending !== false }); return this; }
  limit(n)  { this._limit = n;          return this; }
  range(f, t) { this._rangeFrom = f; this._rangeTo = t; return this; }
  single()  { this._single = true; return this; }

  _match(row) {
    return this._filters.every(f => {
      const v = row[f.col];
      if (f.t === 'eq')  return String(v) === String(f.val);
      if (f.t === 'in')  return f.vals.map(String).includes(String(v));
      if (f.t === 'lt')  { const d = cmpDate(v, f.val); return d ? d[0] < d[1] : Number(v) < Number(f.val); }
      if (f.t === 'gt')  { const d = cmpDate(v, f.val); return d ? d[0] > d[1] : Number(v) > Number(f.val); }
      if (f.t === 'gte') { const d = cmpDate(v, f.val); return d ? d[0] >= d[1] : Number(v) >= Number(f.val); }
      if (f.t === 'lte') return Number(v) <= Number(f.val);
      if (f.t === 'like') {
        const pattern = f.val.replace(/%/g, '.*').replace(/_/g, '.');
        return new RegExp(`^${pattern}$`, 'i').test(String(v));
      }
      return true;
    });
  }

  _sort(rows) {
    if (!this._order.length) return rows;
    return [...rows].sort((a, b) => {
      for (const o of this._order) {
        if (a[o.col] < b[o.col]) return o.asc ? -1 :  1;
        if (a[o.col] > b[o.col]) return o.asc ?  1 : -1;
      }
      return 0;
    });
  }

  async _run() {
    // ── VIEW ────────────────────────────────────────────────
    if (this._isView) {
      let rows = getPriceLookup().filter(r => this._match(r));
      rows = this._sort(rows);
      if (this._limit) rows = rows.slice(0, this._limit);
      return { data: rows, count: rows.length, error: null };
    }

    let rows = loadTable(this._tbl);

    // ── INSERT ──────────────────────────────────────────────
    if (this._op === 'insert') {
      const defaults = TABLE_DEFAULTS[this._tbl]?.() || {};
      const added = this._payload.map(d => ({ ...defaults, id: uuid(), ...d }));
      saveTable(this._tbl, [...rows, ...added]);
      return this._single ? { data: added[0], error: null } : { data: added, error: null };
    }

    // ── UPSERT ──────────────────────────────────────────────
    if (this._op === 'upsert') {
      const keys = (this._upsertOpts.onConflict || 'id').split(',').map(s => s.trim());
      const all  = [...rows];
      const out  = [];
      for (const inc of this._payload) {
        const idx = all.findIndex(r => keys.every(k => String(r[k]) === String(inc[k])));
        if (idx >= 0) { all[idx] = { ...all[idx], ...inc }; out.push(all[idx]); }
        else          { const n = { id: uuid(), ...inc }; all.push(n); out.push(n); }
      }
      saveTable(this._tbl, all);
      return this._single ? { data: out[0], error: null } : { data: out, error: null };
    }

    // ── UPDATE ──────────────────────────────────────────────
    if (this._op === 'update') {
      const updated = [];
      const all = rows.map(r => {
        if (this._match(r)) { const n = { ...r, ...this._payload }; updated.push(n); return n; }
        return r;
      });
      saveTable(this._tbl, all);
      return this._single ? { data: updated[0], error: null } : { data: updated, error: null };
    }

    // ── DELETE ──────────────────────────────────────────────
    if (this._op === 'delete') {
      const del = rows.filter(r => this._match(r));
      saveTable(this._tbl, rows.filter(r => !this._match(r)));
      return { data: del, error: null };
    }

    // ── SELECT ──────────────────────────────────────────────
    const { plain, relations } = parseSelect(this._cols);
    rows = rows.filter(r => this._match(r));
    rows = resolveRelations(rows, relations);
    if (plain) rows = rows.map(r => pickCols(r, plain));
    rows = this._sort(rows);

    if (this._countMode && this._head) return { data: null, count: rows.length, error: null };

    if (this._rangeFrom !== null) rows = rows.slice(this._rangeFrom, this._rangeTo + 1);
    else if (this._limit !== null) rows = rows.slice(0, this._limit);

    if (this._single) {
      if (!rows.length) return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
      return { data: rows[0], error: null };
    }
    return { data: rows, error: null };
  }

  then(resolve, reject) { return this._run().then(resolve, reject); }
}

module.exports = { from: (tbl) => new QueryBuilder(tbl) };
