const supabase = require('../db/supabase');

const MAX_MATCHES_PER_QUERY = 10; // show up to 10 options per search

async function generateQuoteNumber() {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `QT-${dateStr}-`;

  const { data } = await supabase
    .from('quotations')
    .select('quote_number')
    .like('quote_number', `${prefix}%`)
    .order('quote_number', { ascending: false })
    .limit(1);

  let seq = 1;
  if (data && data.length > 0) {
    const last = data[0].quote_number;
    seq = parseInt(last.split('-')[2], 10) + 1;
  }

  return `${prefix}${String(seq).padStart(3, '0')}`;
}

function formatDate(date) {
  return date.toLocaleDateString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

function formatMYR(amount) {
  if (amount == null) return 'TBD';
  return `RM ${parseFloat(amount).toFixed(2)}`;
}

function buildQuotationText(quoteNumber, items) {
  const date = formatDate(new Date());
  const DIVIDER = '━━━━━━━━━━━━━━━━━━━━';
  let lines = [];

  lines.push(`📋 *QUOTATION #${quoteNumber}*`);
  lines.push(`🗓  ${date}`);
  lines.push('');
  lines.push(DIVIDER);
  lines.push('');

  let total = 0;
  let hasTbd = false;       // truly no match (part not in catalog)
  let hasContact = false;   // matched but price not set → Contact to get quote
  let hasMultiple = false;
  let itemNum = 0;

  // Price state: null = no match, 0 = matched but no price, >0 = priced
  const priceState = (p) => p == null ? 'tbd' : (Number(p) === 0 ? 'contact' : 'priced');

  items.forEach((item, idx) => {
    if (item.matches && item.matches.length > 1) {
      hasMultiple = true;
      lines.push(`🔍 *Search:* _${item.raw_query || item.part_number}_`);
      lines.push(`Found *${item.matches.length}* matches — please pick one:`);
      lines.push('');

      item.matches.forEach((m, mi) => {
        itemNum++;
        const letter = String.fromCharCode(65 + mi);
        const state = priceState(m.unit_price);

        lines.push(`*[ ${letter} ]*  \`${m.part_number}\``);
        lines.push(`      ${m.description || '-'}`);
        if (state === 'priced') {
          const subtotal = m.unit_price * item.qty;
          lines.push(`      💰 ${formatMYR(m.unit_price)}  ×  ${item.qty}  =  *${formatMYR(subtotal)}*`);
        } else {
          // Both "contact" (matched, no price) and "tbd" (no match) → show
          // Contact to get quote so sales can follow up.
          hasContact = true;
          lines.push(`      📞 *Contact to get quote*`);
        }
        lines.push('');
      });
    } else {
      itemNum++;
      const m = (item.matches && item.matches[0]) || item;
      const state = priceState(m.unit_price);

      lines.push(`*${itemNum}.*  \`${(state === 'tbd' ? item.part_number : m.part_number) || '-'}\``);
      lines.push(`      ${m.description || item.description || '-'}`);

      if (state === 'priced') {
        const sub = m.unit_price * item.qty;
        item.subtotal = sub;
        item.unit_price = m.unit_price;
        item.part_number = m.part_number;
        item.description = m.description || item.description;
        item.price_source = m.price_source || m.source || 'tbd';
        total += sub;
        lines.push(`      💰 ${formatMYR(m.unit_price)}  ×  ${item.qty}  =  *${formatMYR(sub)}*`);
      } else {
        // Both "contact" (match, no price) and "tbd" (no match) →
        // always show Contact to get quote instead of the cryptic TBD.
        hasContact = true;
        item.subtotal = null;
        item.unit_price = 0;
        item.part_number = m.part_number || item.part_number;
        item.description = m.description || item.description;
        item.price_source = m.price_source || m.source || 'contact';
        lines.push(`      📞 *Contact to get quote*`);
      }
      lines.push('');
    }

    if (idx < items.length - 1) {
      lines.push(DIVIDER);
      lines.push('');
    }
  });

  lines.push(DIVIDER);
  lines.push('');

  if (hasMultiple) {
    lines.push('📝 *How to order:*');
    lines.push('Reply with the letter (A / B / C…) or the full part number of your choice.');
    lines.push('');
  }

  if (hasContact && !hasMultiple) {
    if (total > 0) {
      lines.push(`🧾 *SUBTOTAL:  ${formatMYR(total)}*`);
      lines.push(`📞 _Some items need a quote — our team will follow up._`);
    } else {
      lines.push(`📞 *Please contact us for pricing*`);
      lines.push(`_Our team will follow up with the quote shortly._`);
    }
  } else if (!hasMultiple) {
    lines.push(`🧾 *TOTAL:  ${formatMYR(total)}*`);
  } else {
    lines.push(`🧾 _Total will be confirmed once you choose._`);
  }

  lines.push('');
  lines.push(DIVIDER);
  lines.push('');
  lines.push('⏰  *Valid for 7 days*');
  lines.push('');
  lines.push('*GET IN TOUCH*');
  const phone    = process.env.NTC_PHONE    || '';
  const whatsapp = process.env.NTC_WHATSAPP || '';
  const email    = process.env.NTC_EMAIL    || '';
  const address  = process.env.NTC_ADDRESS  || '';
  if (phone)    lines.push(`📞  *Call:*         ${phone}`);
  if (whatsapp) lines.push(`📲  *WhatsApp:*     ${whatsapp}`);
  if (email)    lines.push(`📧  *Email:*        ${email}`);
  if (address)  lines.push(`📍  *Address:*      ${address}`);
  lines.push(`💬  *Chat here:*    Reply to this message`);
  lines.push('');
  lines.push('_Thank you for choosing NTC Auto Parts_');

  return {
    text: lines.join('\n'),
    total: hasTbd || hasMultiple ? 0 : total,
    hasTbd: hasTbd || hasMultiple || hasContact
  };
}

// Priority: excel (1) → external (2) → manual (3)
// Matching: exact → compact → prefix → contains → description keywords
// Returns matches[] array instead of a single unit_price so customer can choose.
async function lookupPrices(parsedItems) {
  const partNumbers = parsedItems
    .map(i => i.part_number)
    .filter(Boolean);

  if (partNumbers.length === 0) {
    return parsedItems.map(item => ({ ...item, matches: [], unit_price: null, price_source: 'tbd' }));
  }

  // Supabase returns max 1000 rows per request by default. Paginate to fetch
  // the full catalog (25k+ rows) — otherwise most parts never enter `all` and
  // the bot returns TBD for anything beyond the first page.
  const lookup = [];
  const PAGE = 1000;
  for (let start = 0; start < 200000; start += PAGE) {
    const { data, error } = await supabase
      .from('price_lookup')
      .select('part_number, description, unit_price, source')
      .range(start, start + PAGE - 1);
    if (error) break;
    if (!data || data.length === 0) break;
    lookup.push(...data);
    if (data.length < PAGE) break;
  }

  const compact = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Skip [REQUESTED] placeholder rows — they exist only to flag customer demand
  // in the PO basket and must never win a price lookup.
  const isPlaceholder = r =>
    r.source === 'manual' &&
    (!r.unit_price || Number(r.unit_price) === 0) &&
    String(r.description || '').startsWith('[REQUESTED]');

  const all = (lookup || [])
    .filter(r => !isPlaceholder(r))
    .map(r => ({
      ...r,
      rawKey:     r.part_number.toUpperCase().trim(),
      compactKey: compact(r.part_number)
    }));

  const rawMap     = {}; all.forEach(r => { rawMap[r.rawKey]     = r; });
  const compactMap = {}; all.forEach(r => { compactMap[r.compactKey] = r; });

  const byPrice = (a, b) => (a.unit_price || 0) - (b.unit_price || 0);
  const toOutput = r => ({
    part_number:  r.part_number.trim(),
    description:  r.description,
    unit_price:   r.unit_price,
    price_source: r.source
  });

  return parsedItems.map(item => {
    const rawKey     = item.part_number?.toUpperCase().trim();
    const compactKey = compact(item.part_number || '');
    if (!rawKey) return { ...item, matches: [], unit_price: null, price_source: 'tbd' };

    let matches = [];

    // 1. Exact raw match — single hit, done
    if (rawMap[rawKey]) {
      matches = [rawMap[rawKey]];
    }
    // 2. Exact compact match
    else if (compactMap[compactKey]) {
      matches = [compactMap[compactKey]];
    }
    // 3. Starts-with on raw keys
    else {
      matches = all.filter(r => r.rawKey.startsWith(rawKey));
    }
    // 4. Starts-with on compact keys
    if (!matches.length && compactKey.length >= 4) {
      matches = all.filter(r => r.compactKey.startsWith(compactKey));
    }
    // 5. Contains on compact keys
    if (!matches.length && compactKey.length >= 5) {
      matches = all.filter(r => r.compactKey.includes(compactKey));
    }
    // 6. Progressive keyword search — try 100%, 75%, 60% of tokens matching
    if (!matches.length && item.raw_query) {
      const tokens = item.raw_query.toUpperCase().split(/\s+/).filter(t => t.length >= 2);
      if (tokens.length) {
        const scored = all.map(r => {
          const hay = `${(r.description || '').toUpperCase()} ${r.rawKey}`;
          const hits = tokens.filter(t => hay.includes(t)).length;
          return { r, score: hits / tokens.length, hits };
        }).filter(x => x.hits > 0);

        // Try decreasing thresholds until we find matches
        for (const threshold of [1.0, 0.75, 0.6]) {
          const hits = scored.filter(x => x.score >= threshold);
          if (hits.length) {
            matches = hits
              .sort((a, b) => (b.score - a.score) || ((a.r.unit_price || 0) - (b.r.unit_price || 0)))
              .slice(0, MAX_MATCHES_PER_QUERY)
              .map(x => x.r);
            break;
          }
        }
      }
    }

    if (matches.length === 0) {
      // Auto-track customer demand — add to products (source='manual', stock 0)
      // so it flows into the PO restock basket automatically
      trackMissingPart(rawKey, item.raw_query, item.qty || 1).catch(() => {});
      return { ...item, matches: [], unit_price: null, price_source: 'tbd' };
    }

    matches = matches.sort(byPrice).slice(0, MAX_MATCHES_PER_QUERY).map(toOutput);

    // If single match → populate top-level fields too (for DB save + simple rendering)
    if (matches.length === 1) {
      return {
        ...item,
        matches,
        part_number: matches[0].part_number,
        description: item.description || matches[0].description,
        unit_price:  matches[0].unit_price,
        price_source: matches[0].price_source
      };
    }

    // Multiple matches — keep original query text, don't set unit_price (customer must choose)
    return { ...item, matches, unit_price: null, price_source: 'multi' };
  });
}

// ─── Track missing parts (customer demand) ───────────────────────────────
// When a customer asks for something we don't stock, upsert a placeholder
// into products (source='manual', stock_qty=0). The restock basket picks
// this up automatically because stock < threshold.
async function trackMissingPart(partKey, rawQuery, qty) {
  if (!partKey || partKey.length < 2) return;

  // Skip single letters (A/B/C letter-selections), pure commands, etc.
  if (/^[A-Z]$/.test(partKey)) return;

  // Does this part already exist in ANY source? If yes, don't override real data.
  const { data: existing } = await supabase
    .from('products')
    .select('part_number, source, stock_qty')
    .eq('part_number', partKey)
    .limit(1);
  if (existing && existing.length > 0) return; // real product exists

  // Also check: does any real (excel/external) product match as a compact-prefix?
  // Example: user types "45022S9A" → real part "45022-S9A-A01N1" exists → don't track.
  const compact = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const searchCompact = compact(partKey);
  if (searchCompact.length >= 4) {
    // Paginate through full catalog (Supabase returns max 1000 rows/query)
    let hit = false;
    const PAGE = 1000;
    for (let start = 0; start < 200000 && !hit; start += PAGE) {
      const { data, error } = await supabase
        .from('products')
        .select('part_number')
        .in('source', ['excel', 'external'])
        .range(start, start + PAGE - 1);
      if (error || !data || data.length === 0) break;
      hit = data.some(r => compact(r.part_number).startsWith(searchCompact));
      if (data.length < PAGE) break;
    }
    if (hit) return; // real catalog has a matching part — don't create a placeholder
  }

  // Check if we already tracked this as a manual demand row
  const { data: demand } = await supabase
    .from('products')
    .select('part_number, description, stock_qty')
    .eq('part_number', partKey)
    .eq('source', 'manual')
    .maybeSingle?.() || { data: null };

  const description = `[REQUESTED] ${rawQuery || partKey}`;

  await supabase.from('products').upsert({
    part_number: partKey,
    source: 'manual',
    description,
    unit_price: 0,
    stock_qty: 0,
    updated_at: new Date().toISOString()
  }, { onConflict: 'part_number,source' });
}

module.exports = { generateQuoteNumber, buildQuotationText, lookupPrices };
