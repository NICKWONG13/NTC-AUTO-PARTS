// ─── State ───────────────────────────────────────────────────────────────────
let currentTab = 'overview';
let productsCache = [];

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Fetch current user — redirects to login if session expired
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) { location.href = '/login'; return; }
    const data = await res.json();
    if (data.user) {
      const badge = document.getElementById('user-badge');
      if (badge) badge.textContent = `👤 ${data.user}`;
    }
  } catch (_) {}
  showTab('overview');
});

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  location.href = '/login';
}

// ─── Tab navigation ──────────────────────────────────────────────────────────
function showTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.querySelectorAll('.tab').forEach(el => {
    if (el.getAttribute('onclick')?.includes(`'${name}'`)) el.classList.add('active');
  });

  if (name === 'overview') loadOverview();
  else if (name === 'followups') loadFollowups();
  else if (name === 'quotations') loadQuotations();
  else if (name === 'customers') loadCustomers();
  else if (name === 'products') loadProducts();
  else if (name === 'purchase-orders') { loadPOBasket(); loadPOList(); }
  else if (name === 'settings') loadSettings();
}

async function refreshAll() {
  const label = document.getElementById('last-refresh');
  label.textContent = 'Refreshing…';

  try {
    if (currentTab === 'overview')              await loadOverview();
    else if (currentTab === 'followups')        await loadFollowups();
    else if (currentTab === 'quotations')       await loadQuotations();
    else if (currentTab === 'customers')        await loadCustomers();
    else if (currentTab === 'products')         await loadProducts();
    else if (currentTab === 'purchase-orders')  { await loadPOBasket(); await loadPOList(); }
    else if (currentTab === 'settings')         await loadSettings();

    await refreshPOBadge();
    label.textContent = 'Refreshed ' + new Date().toLocaleTimeString();
    toast('✓ Refreshed');
  } catch (e) {
    label.textContent = 'Refresh failed';
    toast('Refresh failed: ' + e.message, 'error');
  }
}

// ─── API helpers ─────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type === 'error' ? 'alert-error' : ''}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// ─── Format helpers ──────────────────────────────────────────────────────────
function fmtMYR(v) {
  if (v == null) return 'TBD';
  return 'RM ' + parseFloat(v).toFixed(2);
}
function fmtDate(s) {
  return new Date(s).toLocaleDateString('en-GB');
}
function daysAgo(s) {
  return Math.floor((Date.now() - new Date(s).getTime()) / 86400000);
}
function daysUntil(s) {
  return Math.floor((new Date(s).getTime() - Date.now()) / 86400000);
}

// ─── Overview ────────────────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const [summary, followups, priceChanges, lowStock] = await Promise.all([
      api('/dashboard/summary'),
      api('/quotations/followups'),
      api('/dashboard/price-changes'),
      api('/dashboard/low-stock')
    ]);

    document.getElementById('stat-today').textContent = summary.total.today;
    document.getElementById('stat-week').textContent = summary.total.week;
    document.getElementById('stat-month').textContent = summary.total.month;
    document.getElementById('stat-revenue').textContent = fmtMYR(summary.won.revenue);

    // Status bars
    const total = summary.total.all || 1;
    document.getElementById('status-bars').innerHTML = [
      { label: 'Won', count: summary.won.count, color: '#22c55e' },
      { label: 'Pending', count: summary.pending.count, color: '#f59e0b' },
      { label: 'Lost', count: summary.lost.count, color: '#ef4444' }
    ].map(({ label, count, color }) => `
      <div class="status-bar-row">
        <span class="status-bar-label">${label}</span>
        <div class="status-bar-track">
          <div class="status-bar-fill" style="width:${Math.round(count/total*100)}%;background:${color}"></div>
        </div>
        <span class="status-bar-count">${count}</span>
      </div>
    `).join('');

    // Source chart
    const maxSrc = Math.max(...(summary.sources || []).map(s => s.count), 1);
    document.getElementById('source-chart').innerHTML = (summary.sources || []).length
      ? summary.sources.map(s => `
          <div class="source-row">
            <span class="source-label">${s.source}</span>
            <div class="source-bar-track">
              <div class="source-bar-fill" style="width:${Math.round(s.count/maxSrc*100)}%"></div>
            </div>
            <span class="source-count">${s.count}</span>
          </div>`).join('')
      : '<span class="muted">No data yet</span>';

    // Badge
    const badge = document.getElementById('badge-followups');
    if (followups.length > 0) {
      badge.textContent = followups.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    // Overdue count + mini list
    document.getElementById('overdue-count').textContent = followups.length;
    document.getElementById('overview-followups').innerHTML = followups.length === 0
      ? '<p class="empty">✅ No overdue follow-ups</p>'
      : renderFollowupCards(followups.slice(0, 5));

    // Price changes panel
    renderPriceChanges(priceChanges);

    // Low stock panel
    renderLowStock(lowStock);

    document.getElementById('last-refresh').textContent = 'Refreshed ' + new Date().toLocaleTimeString();
  } catch (e) {
    toast('Failed to load overview: ' + e.message, 'error');
  }
}

function renderPriceChanges(changes) {
  const el = document.getElementById('price-changes-list');
  if (!el) return;
  if (!changes || changes.length === 0) {
    el.innerHTML = '<p class="empty">No price changes in the last 30 days</p>';
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Part No.</th><th>Source</th><th>Old Price</th><th>New Price</th><th>Stock Δ</th><th>When</th></tr></thead>
    <tbody>
      ${changes.map(c => {
        const priceDir = c.new_price > c.old_price ? 'price-up' : c.new_price < c.old_price ? 'price-down' : 'price-same';
        const priceArrow = c.new_price > c.old_price ? '▲' : c.new_price < c.old_price ? '▼' : '—';
        const stockDiff = (c.new_stock ?? 0) - (c.old_stock ?? 0);
        const stockStr = stockDiff > 0 ? `<span style="color:var(--green)">+${stockDiff}</span>`
                       : stockDiff < 0 ? `<span style="color:var(--red)">${stockDiff}</span>`
                       : '<span class="muted">—</span>';
        return `<tr>
          <td><strong>${c.part_number}</strong><br><small class="muted">${c.description || ''}</small></td>
          <td><span class="src-badge src-badge-on" style="border-color:${SOURCE_COLOR[c.source]||'var(--muted)'};color:${SOURCE_COLOR[c.source]||'var(--muted)'}">${SOURCE_LABEL[c.source]||c.source}</span></td>
          <td class="muted">${fmtMYR(c.old_price)}</td>
          <td class="${priceDir}">${priceArrow} ${fmtMYR(c.new_price)}</td>
          <td>${stockStr}</td>
          <td style="font-size:11px">${fmtDatetime(c.changed_at)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
}

function renderLowStock(data) {
  const el = document.getElementById('low-stock-list');
  const labelEl = document.getElementById('low-stock-threshold-label');
  if (!el) return;
  if (labelEl && data.threshold != null) labelEl.textContent = `(qty < ${data.threshold})`;

  const items = data.items || [];
  if (items.length === 0) {
    el.innerHTML = '<p class="empty">✅ All stock levels OK</p>';
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Part No.</th><th>Description</th><th>Stock</th><th>Price</th><th>Source</th></tr></thead>
    <tbody>
      ${items.map(p => {
        const cls = p.stock_qty === 0 ? 'stock-zero' : 'stock-low';
        return `<tr>
          <td><strong>${p.part_number}</strong></td>
          <td>${p.description}</td>
          <td class="${cls}">${p.stock_qty === 0 ? '⛔ OUT' : p.stock_qty}</td>
          <td>${fmtMYR(p.unit_price)}</td>
          <td><span class="src-badge src-badge-on" style="border-color:${SOURCE_COLOR[p.source]||'var(--muted)'};color:${SOURCE_COLOR[p.source]||'var(--muted)'}">${SOURCE_LABEL[p.source]||p.source}</span></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
}

// ─── Follow-ups ──────────────────────────────────────────────────────────────
async function loadFollowups() {
  try {
    const data = await api('/quotations/followups');
    const el = document.getElementById('followup-list');
    el.innerHTML = data.length === 0
      ? '<p class="empty">✅ No overdue follow-ups right now</p>'
      : renderFollowupCards(data);
  } catch (e) {
    toast('Failed to load follow-ups: ' + e.message, 'error');
  }
}

function renderFollowupCards(items) {
  return items.map(q => {
    const overdueDays = Math.abs(daysUntil(q.follow_up_due));
    const customerName = q.customers?.name || 'Unknown';
    const tgLink = q.customers?.telegram_id
      ? `<a href="https://t.me/${q.customers.username || q.customers.telegram_id}" target="_blank" class="btn btn-outline btn-sm">💬 Telegram</a>`
      : '';
    return `
      <div class="followup-card">
        <div class="followup-info">
          <div class="followup-quote">${q.quote_number} — ${customerName}</div>
          <div class="followup-meta">
            Created: ${fmtDate(q.created_at)} &nbsp;|&nbsp;
            Amount: ${q.has_tbd ? 'TBD' : fmtMYR(q.total_amount)} &nbsp;|&nbsp;
            <span class="followup-overdue">⏰ ${overdueDays}d overdue</span>
          </div>
        </div>
        <div class="followup-actions">
          ${tgLink}
          <button class="btn btn-green btn-sm" onclick="updateStatus('${q.id}','won')">✓ Won</button>
          <button class="btn btn-red btn-sm" onclick="updateStatus('${q.id}','lost')">✗ Lost</button>
        </div>
      </div>
    `;
  }).join('');
}

async function updateStatus(id, status) {
  try {
    await api(`/quotations/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    toast(`Marked as ${status}!`);
    loadFollowups();
    if (currentTab === 'overview') loadOverview();
    if (currentTab === 'quotations') loadQuotations();
  } catch (e) {
    toast('Update failed: ' + e.message, 'error');
  }
}

// ─── Quotations ───────────────────────────────────────────────────────────────
async function loadQuotations() {
  try {
    const status = document.getElementById('filter-status').value;
    const params = status ? `?status=${status}` : '';
    const data = await api(`/quotations${params}`);

    const html = data.length === 0
      ? '<p class="empty">No quotations found</p>'
      : `<div class="table-wrap"><table>
          <thead><tr>
            <th>Quote #</th><th>Customer</th><th>Items</th><th>Total</th>
            <th>Status</th><th>Date</th><th>Actions</th>
          </tr></thead>
          <tbody>
          ${data.map(q => {
            const customer = q.customers?.name || 'Unknown';
            const itemCount = q.quotation_items?.length || 0;
            return `<tr>
              <td><a href="#" onclick="showQuoteDetail('${q.id}');return false;" style="color:var(--accent)">${q.quote_number}</a></td>
              <td>${customer}</td>
              <td>${itemCount} item${itemCount !== 1 ? 's' : ''}</td>
              <td>${q.has_tbd ? '<span style="color:var(--yellow)">TBD</span>' : fmtMYR(q.total_amount)}</td>
              <td><span class="status status-${q.status}">${q.status}</span></td>
              <td>${fmtDate(q.created_at)}</td>
              <td>
                ${q.status === 'pending' ? `
                  <button class="btn btn-green btn-sm" onclick="updateStatus('${q.id}','won')">Won</button>
                  <button class="btn btn-red btn-sm" onclick="updateStatus('${q.id}','lost')">Lost</button>
                ` : `<span class="muted">—</span>`}
              </td>
            </tr>`;
          }).join('')}
          </tbody>
        </table></div>`;

    document.getElementById('quotations-list').innerHTML = html;
  } catch (e) {
    toast('Failed to load quotations: ' + e.message, 'error');
  }
}

async function showQuoteDetail(id) {
  try {
    const q = await api(`/quotations/${id}`);

    const items = q.quotation_items || [];
    // Build Telegram-style quotation text for copying
    const dateStr = new Date(q.created_at).toLocaleDateString('en-GB');
    let copyLines = [`QUOTATION #${q.quote_number}`, `Date: ${dateStr}`, '', 'Items:'];
    items.forEach((item, i) => {
      const unit = item.unit_price != null ? `RM ${parseFloat(item.unit_price).toFixed(2)}` : 'TBD';
      const sub  = item.subtotal   != null ? `RM ${parseFloat(item.subtotal).toFixed(2)}`   : 'TBD';
      copyLines.push(`${i+1}. ${item.part_number||'-'} | ${item.description} | Qty: ${item.qty} | ${unit} ea | ${sub}`);
    });
    copyLines.push('', q.has_tbd ? 'TOTAL: TBD' : `TOTAL: RM ${parseFloat(q.total_amount).toFixed(2)}`);
    copyLines.push('', 'Valid for 7 days.', 'For enquiries, please reply to this message.');
    const copyText = copyLines.join('\n');

    document.getElementById('modal-content').innerHTML = `
      <div class="quote-detail">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <h3>${q.quote_number}</h3>
          <button class="btn btn-outline btn-sm" onclick="copyQuoteText(this)" data-text="${escHtml(copyText)}">📋 Copy Text</button>
        </div>
        <p class="muted" style="margin-bottom:12px">
          Customer: <strong>${q.customers?.name || 'Unknown'}</strong>
          &nbsp;|&nbsp; ${fmtDate(q.created_at)}
          &nbsp;|&nbsp; <span class="status status-${q.status}">${q.status}</span>
        </p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Part No.</th><th>Description</th><th>Qty</th><th>Unit Price</th><th>Source</th><th>Subtotal</th></tr></thead>
            <tbody>
              ${items.map((item, i) => {
                const src = item.price_source || 'tbd';
                const srcColor = SOURCE_COLOR[src] || 'var(--muted)';
                const srcLabel = SOURCE_LABEL[src] || src.toUpperCase();
                return `<tr>
                  <td>${i+1}</td>
                  <td>${item.part_number || '—'}</td>
                  <td>${item.description}</td>
                  <td>${item.qty}</td>
                  <td>${fmtMYR(item.unit_price)}</td>
                  <td><span class="src-badge src-badge-on" style="border-color:${srcColor};color:${srcColor}">${srcLabel}</span></td>
                  <td>${fmtMYR(item.subtotal)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <p class="quote-total" style="margin-top:12px">Total: ${q.has_tbd ? '<span style="color:var(--yellow)">TBD</span>' : fmtMYR(q.total_amount)}</p>
        ${q.notes ? `<p class="muted" style="margin-top:6px;font-size:12px">Notes: ${q.notes}</p>` : ''}
      </div>
    `;
    document.getElementById('modal').classList.remove('hidden');
  } catch (e) {
    toast('Failed to load detail: ' + e.message, 'error');
  }
}

function closeModal(e) {
  if (e.target.id === 'modal') document.getElementById('modal').classList.add('hidden');
}

function copyQuoteText(btn) {
  const text = btn.getAttribute('data-text');
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy Text'; btn.innerHTML = '📋 Copy Text'; }, 2000);
  }).catch(() => toast('Copy failed — please copy manually', 'error'));
}

// ─── Customers ────────────────────────────────────────────────────────────────
async function loadCustomers() {
  try {
    const [customers, sources] = await Promise.all([
      api('/customers'),
      api('/customers/sources')
    ]);

    document.getElementById('source-table').innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Source</th><th>Customers</th></tr></thead>
        <tbody>
          ${sources.map(s => `<tr><td>${s.source}</td><td><strong>${s.count}</strong></td></tr>`).join('')}
        </tbody>
      </table></div>
    `;

    document.getElementById('customers-list').innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Username</th><th>Source</th><th>Joined</th></tr></thead>
        <tbody>
          ${customers.slice(0, 30).map(c => `<tr>
            <td>${c.name || '—'}</td>
            <td>${c.username ? '@' + c.username : '—'}</td>
            <td>
              <select onchange="updateSource('${c.id}', this.value)" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:2px 6px;font-size:12px">
                ${['Telegram','WhatsApp','Walk-in','Referral','Online','Other'].map(src =>
                  `<option value="${src}" ${c.source === src ? 'selected' : ''}>${src}</option>`
                ).join('')}
              </select>
            </td>
            <td>${fmtDate(c.created_at)}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    `;
  } catch (e) {
    toast('Failed to load customers: ' + e.message, 'error');
  }
}

async function updateSource(id, source) {
  try {
    await api(`/customers/${id}/source`, { method: 'PATCH', body: JSON.stringify({ source }) });
    toast('Source updated');
  } catch (e) {
    toast('Update failed: ' + e.message, 'error');
  }
}

// ─── Products ────────────────────────────────────────────────────────────────
// Priority order: excel (1) → external (2) → manual (3)
const SOURCE_PRIORITY = { excel: 1, external: 2, manual: 3 };
const SOURCE_LABEL = { excel: 'Excel', external: 'External', manual: 'Manual' };
const SOURCE_COLOR = { excel: '#22c55e', external: '#4f7cff', manual: '#f59e0b' };

async function loadProducts() {
  try {
    // Load status cards and product table in parallel
    const [all, lookup, settings] = await Promise.all([
      api('/products'),
      api('/products/lookup'),
      api('/settings')
    ]);

    // Refresh Excel status card
    refreshExcelStatus(settings.excel_last_filename ? {
      filename: settings.excel_last_filename,
      time: settings.excel_last_import,
      imported: settings.excel_last_count
    } : null);

    // Refresh External status card
    refreshExternalStatus((settings.ext_api_url || settings.ext_api_last_sync) ? {
      url: settings.ext_api_url,
      time: settings.ext_api_last_sync,
      count: settings.ext_api_last_count
    } : null);
    productsCache = all;

    // Build effective price map (active source per part)
    const activeMap = {};
    lookup.forEach(p => { activeMap[p.part_number] = p.source; });

    // Group rows by part_number
    const grouped = {};
    all.forEach(p => {
      if (!grouped[p.part_number]) grouped[p.part_number] = [];
      grouped[p.part_number].push(p);
    });

    renderProductsTable(grouped, activeMap);
  } catch (e) {
    toast('Failed to load products: ' + e.message, 'error');
  }
}

function renderProductsTable(grouped, activeMap) {
  const parts = Object.keys(grouped).sort();
  if (parts.length === 0) {
    document.getElementById('products-list').innerHTML =
      '<p class="empty">No products yet. Import the Excel stock file or add manually.</p>';
    return;
  }

  const rows = parts.map(partNumber => {
    const records = grouped[partNumber];
    const activeSource = activeMap[partNumber];
    const activeRecord = records.find(r => r.source === activeSource) || records[0];

    const sourceBadges = ['excel', 'external', 'manual'].map(src => {
      const rec = records.find(r => r.source === src);
      if (!rec) return `<span class="src-badge src-badge-off">${SOURCE_LABEL[src]}</span>`;
      const isActive = src === activeSource;
      return `<span class="src-badge src-badge-on" style="border-color:${SOURCE_COLOR[src]};color:${SOURCE_COLOR[src]}" title="${SOURCE_LABEL[src]}: RM ${parseFloat(rec.unit_price).toFixed(2)} | Stock: ${rec.stock_qty}">${isActive ? '★ ' : ''}${SOURCE_LABEL[src]}</span>`;
    }).join('');

    // Manual record for editing (always show manual price input)
    const manualRec = records.find(r => r.source === 'manual');

    return `<tr>
      <td><strong>${partNumber}</strong><br><small class="muted">${sourceBadges}</small></td>
      <td>${escHtml(activeRecord.description)}</td>
      <td style="color:${SOURCE_COLOR[activeSource] || 'var(--text)'}"><strong>${fmtMYR(activeRecord.unit_price)}</strong><br><small class="muted">via ${SOURCE_LABEL[activeSource] || '—'}</small></td>
      <td>${activeRecord.stock_qty}</td>
      <td>${fmtDate(activeRecord.updated_at)}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="editManual('${partNumber}','${escHtml(manualRec?.description || activeRecord.description)}',${manualRec?.unit_price ?? activeRecord.unit_price},${manualRec?.stock_qty ?? activeRecord.stock_qty})">✏ Manual</button>
        ${manualRec ? `<button class="btn btn-red btn-sm" onclick="deleteProduct('${partNumber}','manual')">✕</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  document.getElementById('products-list').innerHTML = `
    <div class="legend-row">
      <span class="src-badge src-badge-on" style="border-color:#22c55e;color:#22c55e">★ Excel</span> highest priority &nbsp;→&nbsp;
      <span class="src-badge src-badge-on" style="border-color:#4f7cff;color:#4f7cff">External</span> &nbsp;→&nbsp;
      <span class="src-badge src-badge-on" style="border-color:#f59e0b;color:#f59e0b">Manual</span> fallback
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Part Number / Sources</th><th>Description</th>
        <th>Active Price</th><th>Stock</th><th>Updated</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// Live filter product table rows by search term
function filterProducts(term) {
  const q = term.toLowerCase().trim();
  const rows = document.querySelectorAll('#products-list tbody tr');
  let visible = 0;
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    const show = !q || text.includes(q);
    row.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  const countEl = document.getElementById('product-count');
  if (countEl) countEl.textContent = q ? `${visible} result${visible !== 1 ? 's' : ''}` : '';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Edit/override the manual price for a part
function editManual(partNumber, description, unitPrice, stockQty) {
  document.getElementById('add-product-form').classList.remove('hidden');
  document.getElementById('new-part').value = partNumber;
  document.getElementById('new-part').readOnly = true;
  document.getElementById('new-desc').value = description;
  document.getElementById('new-price').value = unitPrice;
  document.getElementById('new-stock').value = stockQty;
  document.getElementById('new-part').focus();
}

async function saveProduct(partNumber, source, field, value) {
  try {
    const product = productsCache.find(p => p.part_number === partNumber && p.source === source);
    if (!product) return;
    const update = { source, description: product.description, unit_price: product.unit_price, stock_qty: product.stock_qty };
    update[field] = field === 'description' ? value : parseFloat(value) || 0;
    if (field === 'stock_qty') update[field] = parseInt(value, 10) || 0;

    const updated = await api(`/products/${encodeURIComponent(partNumber)}`, {
      method: 'PUT',
      body: JSON.stringify(update)
    });
    Object.assign(product, updated);
    toast('Saved');
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

async function deleteProduct(partNumber, source = 'manual') {
  if (!confirm(`Delete ${partNumber} (${SOURCE_LABEL[source]} entry)?`)) return;
  try {
    await api(`/products/${encodeURIComponent(partNumber)}?source=${source}`, { method: 'DELETE' });
    productsCache = productsCache.filter(p => !(p.part_number === partNumber && p.source === source));
    toast('Deleted');
    loadProducts();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'error');
  }
}

function showAddProduct() {
  document.getElementById('add-product-form').classList.remove('hidden');
  document.getElementById('new-part').readOnly = false;
  document.getElementById('new-part').focus();
}
function hideAddProduct() {
  document.getElementById('add-product-form').classList.add('hidden');
  document.getElementById('new-part').readOnly = false;
  ['new-part','new-desc','new-price','new-stock'].forEach(id => document.getElementById(id).value = '');
}

async function addProduct() {
  const part_number = document.getElementById('new-part').value.trim();
  const description = document.getElementById('new-desc').value.trim();
  const unit_price = parseFloat(document.getElementById('new-price').value) || 0;
  const stock_qty = parseInt(document.getElementById('new-stock').value, 10) || 0;

  if (!part_number || !description) { toast('Part number and description required', 'error'); return; }
  try {
    await api('/products', { method: 'POST', body: JSON.stringify({ part_number, description, unit_price, stock_qty }) });
    hideAddProduct();
    toast('Manual price saved');
    loadProducts();
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
}

// ─── Excel Import (CLIENT-SIDE parse → chunked JSON upload) ─────────────────
// Browser parses the Excel file with SheetJS, extracts products, then POSTs
// compact JSON in batches of 1000 rows. Avoids Vercel's 4.5 MB body limit.
async function importExcel(input, context = 'products') {
  const file = input.files[0];
  if (!file) return;

  const resultId = context === 'settings' ? 'settings-import-result' : 'import-result';
  const resultEl = document.getElementById(resultId);
  resultEl.className = 'alert';
  resultEl.textContent = '⏳ Reading Excel file…';
  resultEl.classList.remove('hidden');

  try {
    if (typeof XLSX === 'undefined') throw new Error('Excel parser not loaded. Please refresh the page.');

    // Read as ArrayBuffer
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', header: 1 });
    if (!raw || raw.length < 2) throw new Error('Excel file is empty or too short');

    // ── Header + column detection (mirrors server logic) ───────────────────
    const norm = s => String(s).toLowerCase().replace(/[\s_\-\.()#\/]/g, '');
    const PRICE_KW = ['price','harga','rate','cost','amt','sellingprice','unitprice','avgcost'];
    const STOCK_KW = ['stock','qty','quantity','onhand','baki','balance','qoh','bal'];
    const PART_KW  = ['part','itemcode','itemno','code','item'];
    const DESC_KW  = ['description','itemdesc','desc','keterangan','barang'];

    let headerRowIdx = 0;
    for (let i = 0; i < Math.min(raw.length, 30); i++) {
      const named = raw[i].filter(c => c && isNaN(c) && String(c).trim().length > 1);
      if (named.length >= 3) { headerRowIdx = i; break; }
    }
    const headerRow = raw[headerRowIdx];
    const dataRows  = raw.slice(headerRowIdx + 1);

    const samples = dataRows.slice(0, 40).filter(r => r.some(c => c !== ''));
    const looksLikePart = (ci) => {
      const vals = samples.map(r => String(r[ci] ?? '').trim()).filter(Boolean);
      if (!vals.length) return false;
      if (vals.every((v, i) => Number(v) === i + 1)) return false;
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

    if (iPart < 0 || iDesc < 0) {
      // Fallback detection by data patterns
      const colStats = headerRow.map((_, ci) => {
        const vals = samples.map(r => String(r[ci] ?? '').trim()).filter(v => v.length > 0);
        if (!vals.length) return { ci, avgLen: 0, isNum: true, isText: false };
        const avgLen = vals.reduce((s, v) => s + v.length, 0) / vals.length;
        const numCount = vals.filter(v => !isNaN(Number(v)) && v !== '').length;
        const isSeq = vals.every((v, i) => Number(v) === i + 1);
        const isNum  = numCount / vals.length > 0.8;
        const isText = !isNum && !isSeq && avgLen > 1;
        return { ci, avgLen, isNum, isText };
      });
      const textCols = colStats.filter(c => c.isText && c.ci !== iPrice && c.ci !== iStock);
      if (iPart < 0 && textCols.length > 0) iPart = textCols.reduce((a, b) => a.ci < b.ci ? a : b).ci;
      if (iDesc < 0) {
        const cand = textCols.filter(c => c.ci !== iPart).sort((a, b) => b.avgLen - a.avgLen)[0];
        if (cand) iDesc = cand.ci;
      }
    }

    if (iPart < 0 || iDesc < 0) {
      throw new Error(`Cannot detect Part Number or Description columns. Headers: ${headerRow.filter(h => h).join(', ') || '(none)'}`);
    }

    // ── Build compact product list ─────────────────────────────────────────
    const products = dataRows
      .map(row => ({
        part_number: String(row[iPart] ?? '').trim().toUpperCase(),
        description: String(row[iDesc] ?? '').trim() || '-',
        unit_price: iPrice >= 0 ? (parseFloat(String(row[iPrice]).replace(/[^0-9.]/g, '')) || 0) : 0,
        stock_qty:  iStock >= 0 ? (parseInt(String(row[iStock]).replace(/[^0-9]/g, ''), 10) || 0) : 0,
      }))
      .filter(p => p.part_number && p.part_number.length > 1 && isNaN(p.part_number));

    if (!products.length) throw new Error('No valid product rows found after parsing');

    // ── Chunked upload ─────────────────────────────────────────────────────
    const CHUNK = 1000;
    const totalChunks = Math.ceil(products.length / CHUNK);
    let imported = 0;

    for (let ci = 0; ci < totalChunks; ci++) {
      const chunk = products.slice(ci * CHUNK, (ci + 1) * CHUNK);
      resultEl.textContent = `⏳ Uploading ${ci + 1}/${totalChunks} (${imported}/${products.length} so far)…`;

      const res = await fetch('/api/products/import-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          products: chunk,
          first: ci === 0,
          finalize: ci === totalChunks - 1,
          total: products.length
        })
      });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { throw new Error('Server error: ' + text.slice(0, 140)); }
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      imported += data.imported || chunk.length;
    }

    resultEl.className = 'alert alert-success';
    resultEl.innerHTML = `✓ <strong>${imported} products</strong> imported from <em>${file.name}</em><br>
      <small>Columns — Part: <b>col[${iPart}]</b> | Desc: <b>col[${iDesc}]</b> |
      Price: <b>${iPrice >= 0 ? 'col[' + iPrice + ']' : '(default 0)'}</b> |
      Stock: <b>${iStock >= 0 ? 'col[' + iStock + ']' : '(default 0)'}</b></small>`;

    refreshExcelStatus({ filename: file.name, imported, time: new Date().toISOString() });
    if (currentTab === 'products') loadProducts();
  } catch (e) {
    resultEl.className = 'alert alert-error';
    resultEl.textContent = '✗ Import failed: ' + e.message;
  }
  input.value = '';
}

// ─── External Sync ────────────────────────────────────────────────────────────
async function syncExternal() {
  const extStatusEl = document.getElementById('external-status');
  if (extStatusEl) extStatusEl.innerHTML = '<span class="muted">⏳ Syncing…</span>';

  try {
    const data = await api('/products/sync', { method: 'POST' });
    toast(`✓ Synced ${data.synced} products from external system`);
    refreshExternalStatus({ synced: data.synced, time: new Date().toISOString() });
    if (currentTab === 'products') loadProducts();
  } catch (e) {
    toast('Sync failed: ' + e.message, 'error');
    if (extStatusEl) extStatusEl.innerHTML = `<span style="color:var(--red)">✗ ${e.message}</span>`;
  }
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function fmtDatetime(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function refreshExcelStatus(data) {
  const html = data
    ? `<div class="stat-row"><span class="stat-label">File</span><span class="stat-val">${data.filename || '—'}</span></div>
       <div class="stat-row"><span class="stat-label">Last Import</span><span class="stat-val">${fmtDatetime(data.time || new Date().toISOString())}</span></div>
       <div class="stat-row"><span class="stat-label">Records</span><span class="stat-val">${data.imported ?? data.count ?? '—'}</span></div>`
    : '<span class="muted">No Excel file uploaded yet</span>';

  ['excel-status', 'settings-excel-status'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

function refreshExternalStatus(data) {
  const el = document.getElementById('external-status');
  if (!el) return;
  if (!data || (!data.url && !data.synced && !data.time)) {
    el.innerHTML = '<span class="muted">Not configured. Set API URL in ⚙️ Settings.</span>';
    return;
  }
  el.innerHTML = `
    <div class="stat-row"><span class="stat-label">API URL</span><span class="stat-val" style="font-size:11px;word-break:break-all">${data.url || '(configured)'}</span></div>
    <div class="stat-row"><span class="stat-label">Last Sync</span><span class="stat-val">${fmtDatetime(data.time)}</span></div>
    <div class="stat-row"><span class="stat-label">Records</span><span class="stat-val">${data.count ?? data.synced ?? '—'}</span></div>`;
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const s = await api('/settings');

    // Populate external API fields
    document.getElementById('cfg-api-url').value = s.ext_api_url || '';
    document.getElementById('cfg-api-key').value = s.ext_api_key || '';

    // Low stock threshold
    const lowStockEl = document.getElementById('cfg-low-stock');
    if (lowStockEl) lowStockEl.value = s.low_stock_threshold || '5';

    // Auto-sync interval
    const intervalEl = document.getElementById('cfg-sync-interval');
    if (intervalEl) intervalEl.value = s.ext_sync_interval || '';

    // Last sync status
    const syncStatusEl = document.getElementById('sync-status');
    if (syncStatusEl && s.ext_api_last_sync) {
      syncStatusEl.textContent = `Last synced: ${fmtDatetime(s.ext_api_last_sync)}  |  ${s.ext_api_last_count || 0} records`;
    }

    // Excel status in Settings panel
    const excelData = s.excel_last_filename ? {
      filename: s.excel_last_filename,
      time: s.excel_last_import,
      count: s.excel_last_count
    } : null;
    refreshExcelStatus(excelData);

    // External status in Products tab
    const extData = (s.ext_api_url || s.ext_api_last_sync) ? {
      url: s.ext_api_url,
      time: s.ext_api_last_sync,
      count: s.ext_api_last_count
    } : null;
    refreshExternalStatus(extData);

  } catch (e) {
    toast('Failed to load settings: ' + e.message, 'error');
  }
}

async function saveLowStockThreshold() {
  const val = document.getElementById('cfg-low-stock').value.trim();
  if (!val || isNaN(val)) { toast('Please enter a valid number', 'error'); return; }
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ low_stock_threshold: val }) });
    toast(`✓ Low stock threshold set to ${val}`);
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

async function saveExtSettings() {
  const url = document.getElementById('cfg-api-url').value.trim();
  const key = document.getElementById('cfg-api-key').value.trim();
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ ext_api_url: url, ext_api_key: key }) });
    toast('✓ Settings saved');
    // Refresh external status display in Products tab
    refreshExternalStatus({ url, time: null, count: null });
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

async function saveSyncInterval() {
  const interval = document.getElementById('cfg-sync-interval').value;
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ ext_sync_interval: interval }) });
    // Tell server to re-read interval and reschedule cron
    await fetch('/api/settings/reschedule', { method: 'POST' });
    toast(interval ? `✓ Auto-sync set to every ${interval}h` : '✓ Auto-sync disabled');
    const syncStatusEl = document.getElementById('sync-status');
    if (syncStatusEl) syncStatusEl.textContent = interval ? `Auto-sync: every ${interval}h` : 'Auto-sync: disabled';
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

async function testExternal() {
  const url = document.getElementById('cfg-api-url').value.trim();
  const key = document.getElementById('cfg-api-key').value.trim();
  const resultEl = document.getElementById('ext-test-result');

  if (!url) {
    resultEl.className = 'alert alert-error';
    resultEl.textContent = '✗ Please enter an API URL first';
    resultEl.classList.remove('hidden');
    return;
  }

  resultEl.className = 'alert';
  resultEl.textContent = '⏳ Testing connection…';
  resultEl.classList.remove('hidden');

  try {
    // Test only — does NOT save settings or import data
    const data = await api('/settings/test-external', {
      method: 'POST',
      body: JSON.stringify({ url, key })
    });
    resultEl.className = 'alert alert-success';
    resultEl.innerHTML = `✓ Connected! Found <strong>${data.count}</strong> products.<br>
      <small>Sample: ${data.sample.map(p => p.part_number || p.partNumber || JSON.stringify(p)).join(', ')}</small><br>
      <small>Press <strong>💾 Save</strong> to save settings, then go to Products tab → <strong>🔄 Sync Now</strong>.</small>`;
  } catch (e) {
    resultEl.className = 'alert alert-error';
    resultEl.textContent = '✗ Connection failed: ' + e.message;
  }
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
  else { input.type = 'password'; btn.textContent = '👁'; }
}

// ─── Telegram Reminder ───────────────────────────────────────────────────────
async function sendReminder() {
  try {
    const res = await fetch('/api/remind', { method: 'POST' });
    if (!res.ok) throw new Error('Server error');
    toast('✓ Reminder sent to Telegram');
  } catch (e) {
    toast('Failed to send reminder: ' + e.message, 'error');
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  PURCHASE ORDERS
// ═════════════════════════════════════════════════════════════════════════

let basketItems = [];

async function refreshPOBadge() {
  try {
    const { items } = await api('/purchase-orders/basket');
    const badge = document.getElementById('badge-po-basket');
    if (items.length > 0) {
      badge.textContent = items.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch {}
}

async function loadPOBasket() {
  const list = document.getElementById('po-basket-list');
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const { threshold, items } = await api('/purchase-orders/basket');
    basketItems = items;

    const badge = document.getElementById('basket-count');
    const tabBadge = document.getElementById('badge-po-basket');
    if (items.length > 0) {
      badge.textContent = items.length; badge.classList.remove('hidden');
      tabBadge.textContent = items.length; tabBadge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden'); tabBadge.classList.add('hidden');
    }

    if (items.length === 0) {
      list.innerHTML = `<div class="empty">✅ All stocks above reorder threshold (qty ≥ ${threshold}). Nothing to restock.</div>`;
      return;
    }

    list.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th style="width:30px"><input type="checkbox" id="basket-select-all" checked onchange="togglePOSelectAll(this.checked)"></th>
            <th>Part No.</th>
            <th>Description</th>
            <th>Type</th>
            <th>Current Stock</th>
            <th>Unit Cost</th>
            <th>Order Qty</th>
            <th>Subtotal</th>
            <th style="width:50px"></th>
          </tr></thead>
          <tbody>
            ${items.map((it, i) => {
              const isRequested = (it.description || '').startsWith('[REQUESTED]');
              const cleanDesc = isRequested ? it.description.replace('[REQUESTED]', '').trim() : it.description;
              const typeBadge = isRequested
                ? '<span class="status status-pending" style="font-size:10px">🔔 CUSTOMER REQUEST</span>'
                : '<span class="status status-lost" style="font-size:10px">📉 LOW STOCK</span>';
              const qty = 1;
              return `
              <tr data-idx="${i}">
                <td><input type="checkbox" class="basket-chk" ${isRequested ? '' : 'checked'}></td>
                <td><strong>${it.part_number}</strong></td>
                <td>${cleanDesc || '-'}</td>
                <td>${typeBadge}</td>
                <td class="${it.current_stock === 0 ? 'stock-zero' : 'stock-low'}">${it.current_stock === 0 ? '⛔ OUT' : it.current_stock}</td>
                <td>${it.unit_cost ? fmtMYR(it.unit_cost) : '<span class="muted">TBD</span>'}</td>
                <td><input type="number" class="editable basket-qty" min="0" value="${qty}" style="width:70px" oninput="updateBasketSubtotal(${i})"></td>
                <td class="basket-subtotal"><strong>${fmtMYR((it.unit_cost || 0) * qty)}</strong></td>
                <td><button class="btn btn-red btn-sm" onclick="removeBasketItem(${i})" title="Remove from basket">✕</button></td>
              </tr>
            `}).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    list.innerHTML = `<div class="alert alert-error">Failed: ${e.message}</div>`;
  }
}

function togglePOSelectAll(checked) {
  document.querySelectorAll('.basket-chk').forEach(c => c.checked = checked);
}

async function removeBasketItem(i) {
  const it = basketItems[i];
  if (!it) return;

  // Optimistically remove row from DOM — no full reload
  const row = document.querySelector(`#po-basket-list tr[data-idx="${i}"]`);
  if (row) row.remove();

  // Update counter badges locally
  const remaining = document.querySelectorAll('#po-basket-list tr[data-idx]').length;
  const badge = document.getElementById('basket-count');
  const tabBadge = document.getElementById('badge-po-basket');
  if (remaining > 0) {
    badge.textContent = remaining; badge.classList.remove('hidden');
    tabBadge.textContent = remaining; tabBadge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden'); tabBadge.classList.add('hidden');
    document.getElementById('po-basket-list').innerHTML =
      '<div class="empty">✅ All items removed. Click Refresh to reload the basket.</div>';
  }

  // Fire-and-forget to DB
  try {
    await api(`/purchase-orders/basket/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ part_number: it.part_number })
    });
    toast(`✓ Removed ${it.part_number}`);
  } catch (e) {
    toast(`Failed to persist removal: ${e.message}`, 'error');
  }
}

function updateBasketSubtotal(i) {
  const row = document.querySelector(`#po-basket-list tr[data-idx="${i}"]`);
  const qty = parseInt(row.querySelector('.basket-qty').value, 10) || 0;
  const cost = basketItems[i].unit_cost || 0;
  const cell = row.querySelector('.basket-subtotal');
  cell.innerHTML = qty > 0 ? `<strong>${fmtMYR(cost * qty)}</strong>` : '<span class="muted">—</span>';
}

async function createPOFromBasket() {
  const rows = document.querySelectorAll('#po-basket-list tr[data-idx]');
  const items = [];
  let skippedNoQty = 0;
  rows.forEach(row => {
    const i = parseInt(row.dataset.idx, 10);
    const checked = row.querySelector('.basket-chk').checked;
    if (!checked) return;
    const qty = parseInt(row.querySelector('.basket-qty').value, 10);
    if (!qty || qty < 1) { skippedNoQty++; return; }
    const it = basketItems[i];
    items.push({
      part_number: it.part_number,
      description: it.description,
      qty,
      unit_cost: it.unit_cost,
      current_stock: it.current_stock
    });
  });

  if (!items.length) {
    toast(skippedNoQty > 0 ? `Enter order qty for selected items (${skippedNoQty} skipped).` : 'Select at least one item.', 'error');
    return;
  }
  if (skippedNoQty > 0) {
    if (!confirm(`${skippedNoQty} selected item(s) have no qty and will be skipped. Continue?`)) return;
  }

  const supplier = prompt('Supplier name (optional):') || null;

  try {
    const po = await api('/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({ items, supplier })
    });
    toast(`✓ Purchase Order ${po.po_number} created with ${items.length} items`);
    loadPOBasket();
    loadPOList();
  } catch (e) {
    toast('Failed to create PO: ' + e.message, 'error');
  }
}

async function loadPOList() {
  const status = document.getElementById('po-status-filter')?.value || '';
  const list = document.getElementById('po-list');
  list.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const data = await api(`/purchase-orders${status ? '?status=' + status : ''}`);
    if (!data.length) { list.innerHTML = '<div class="empty">No purchase orders yet.</div>'; return; }

    const statusColor = { draft: 'pending', sent: 'pending', received: 'won', cancelled: 'lost' };
    list.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>PO #</th><th>Supplier</th><th>Total</th>
            <th>Status</th><th>Created</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${data.map(po => `
              <tr>
                <td><a href="javascript:showPODetail('${po.id}')"><strong>${po.po_number}</strong></a></td>
                <td>${po.supplier || '-'}</td>
                <td>${fmtMYR(po.total_amount)}</td>
                <td><span class="status status-${statusColor[po.status]}">${po.status.toUpperCase()}</span></td>
                <td>${fmtDate(po.created_at)}</td>
                <td>
                  ${po.status === 'draft' ? `<button class="btn btn-primary btn-sm" onclick="updatePOStatus('${po.id}','sent')">Mark Sent</button>` : ''}
                  ${po.status === 'sent' ? `<button class="btn btn-green btn-sm" onclick="updatePOStatus('${po.id}','received')">✓ Received</button>` : ''}
                  ${po.status !== 'received' && po.status !== 'cancelled' ? `<button class="btn btn-red btn-sm" onclick="updatePOStatus('${po.id}','cancelled')">Cancel</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    list.innerHTML = `<div class="alert alert-error">Failed: ${e.message}</div>`;
  }
}

async function showPODetail(id) {
  try {
    const po = await api(`/purchase-orders/${id}`);
    document.getElementById('modal-content').innerHTML = `
      <div class="quote-detail">
        <h3>📦 ${po.po_number}</h3>
        <p class="muted" style="margin-bottom:12px">
          Supplier: <strong>${po.supplier || '-'}</strong>
          &nbsp;|&nbsp; ${fmtDate(po.created_at)}
          &nbsp;|&nbsp; <span class="status status-${po.status === 'received' ? 'won' : (po.status === 'cancelled' ? 'lost' : 'pending')}">${po.status.toUpperCase()}</span>
        </p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Part No.</th><th>Description</th><th>Qty</th><th>Unit Cost</th><th>Subtotal</th></tr></thead>
            <tbody>
              ${po.items.map((it, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td><strong>${it.part_number}</strong></td>
                  <td>${it.description || '-'}</td>
                  <td>${it.qty}</td>
                  <td>${fmtMYR(it.unit_cost)}</td>
                  <td><strong>${fmtMYR(it.subtotal)}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="quote-total" style="text-align:right">Total: <strong>${fmtMYR(po.total_amount)}</strong></div>
        ${po.notes ? `<p class="muted" style="margin-top:6px;font-size:12px">Notes: ${po.notes}</p>` : ''}
      </div>
    `;
    document.getElementById('modal').classList.remove('hidden');
  } catch (e) { toast(e.message, 'error'); }
}

async function updatePOStatus(id, status) {
  if (!confirm(`Change status to "${status}"?${status === 'received' ? ' Stock will be topped up.' : ''}`)) return;
  try {
    await api(`/purchase-orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    toast(`✓ PO marked as ${status}`);
    loadPOList();
    if (status === 'received') loadPOBasket(); // stock changed → basket may update
  } catch (e) { toast(e.message, 'error'); }
}

// Refresh PO badge on initial load and every 60s
refreshPOBadge();
setInterval(refreshPOBadge, 60000);
