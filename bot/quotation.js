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
  let hasTbd = false;
  let hasMultiple = false;
  let itemNum = 0;

  items.forEach((item, idx) => {
    if (item.matches && item.matches.length > 1) {
      hasMultiple = true;
      lines.push(`🔍 *Search:* _${item.raw_query || item.part_number}_`);
      lines.push(`Found *${item.matches.length}* matches — please pick one:`);
      lines.push('');

      item.matches.forEach((m, mi) => {
        itemNum++;
        const subtotal = m.unit_price != null ? m.unit_price * item.qty : null;
        const letter = String.fromCharCode(65 + mi);

        lines.push(`*[ ${letter} ]*  \`${m.part_number}\``);
        lines.push(`      ${m.description || '-'}`);
        lines.push(`      💰 ${formatMYR(m.unit_price)}  ×  ${item.qty}  =  *${formatMYR(subtotal)}*`);
        lines.push('');
      });
    } else {
      itemNum++;
      const m = (item.matches && item.matches[0]) || item;
      if (m.unit_price != null) {
        const sub = m.unit_price * item.qty;
        item.subtotal = sub;
        item.unit_price = m.unit_price;
        item.part_number = m.part_number;
        item.description = m.description || item.description;
        item.price_source = m.price_source || m.source || 'tbd';
        total += sub;

        lines.push(`*${itemNum}.*  \`${item.part_number || '-'}\``);
        lines.push(`      ${item.description || '-'}`);
        lines.push(`      💰 ${formatMYR(item.unit_price)}  ×  ${item.qty}  =  *${formatMYR(sub)}*`);
      } else {
        hasTbd = true;
        item.subtotal = null;
        lines.push(`*${itemNum}.*  \`${item.part_number || '-'}\``);
        lines.push(`      ${item.description || '-'}`);
        lines.push(`      💰 *TBD*  ×  ${item.qty}  =  *TBD*`);
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

  if (hasTbd) {
    lines.push(`🧾 *TOTAL:* _Partial — some prices TBD_`);
    lines.push(`_Our team will follow up with the complete price._`);
  } else if (!hasMultiple) {
    lines.push(`🧾 *TOTAL:  ${formatMYR(total)}*`);
  } else {
    lines.push(`🧾 _Total will be confirmed once you choose._`);
  }

  lines.push('');
  lines.push(DIVIDER);
  lines.push('');
  lines.push('⏰  Valid for 7 days');
  lines.push('💬  Reply to this message for enquiries');

  return { text: lines.join('\n'), total: hasTbd || hasMultiple ? 0 : total, hasTbd: hasTbd || hasMultiple };
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

  const { data: lookup } = await supabase
    .from('price_lookup')
    .select('part_number, description, unit_price, source');

  const compact = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const all = (lookup || []).map(r => ({
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

module.exports = { generateQuoteNumber, buildQuotationText, lookupPrices };
