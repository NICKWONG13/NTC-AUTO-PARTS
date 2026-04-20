const supabase = require('../db/supabase');
const { generateQuoteNumber, buildQuotationText, lookupPrices } = require('./quotation');

// ─── Help text ────────────────────────────────────────────────────────────────
const HELP_TEXT = `👋 Welcome to NTC Auto Parts!

*📝 Guided quote (recommended):*
Type /new and I'll walk you through step by step:
  1️⃣ PART NUMBER
  2️⃣ DESCRIPTION
  3️⃣ QUANTITY

*Quick format (advanced):*
Send one item per line:
\`\`\`
ABC123 | Brake Pad | 2
XYZ456 | Oil Filter | 1
\`\`\`

*Commands:*
/new – start a guided quote
/done – finish and generate quote
/cancel – abort current quote
/myquotes – view your recent quotations`;

const SALES_HELP = `*Sales Commands:*
/remind — Send overdue follow-up list
/stats — Today's sales summary
/pending — List pending quotes
/price ABC123 — Check price of a part`;

// ─── Smart parser ────────────────────────────────────────────────────────────
// Handles:
//   ABC123 | Brake Pad | 2      (full)
//   ABC123 | 2                  (no description)
//   ABC123                      (just part number)
//   ABC123 2                    (space-separated qty)
function parseItems(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('/'));
  const items = [];

  for (const line of lines) {
    if (line.includes('|')) {
      const parts = line.split('|').map(p => p.trim());
      const partNumber = parts[0].toUpperCase() || null;
      if (!partNumber) continue;

      // Detect if parts[1] is a number (qty) or a description
      const second = parts[1] || '';
      const secondIsQty = /^\d+$/.test(second);

      if (secondIsQty || parts.length === 2 && !parts[1]) {
        // Format: ABC123 | 2  or  ABC123 |
        const qty = secondIsQty ? parseInt(second, 10) : 1;
        items.push({ part_number: partNumber, description: null, qty, needsLookup: true });
      } else {
        // Format: ABC123 | Brake Pad | 2
        const description = second || null;
        const qty = parseInt(parts[2], 10) || 1;
        items.push({ part_number: partNumber, description, qty, needsLookup: !description });
      }
    } else {
      // No pipe — try "PARTNO QTY" or just "PARTNO"
      const words = line.split(/\s+/);
      const lastWord = words[words.length - 1];
      let searchText, qty;
      if (words.length > 1 && /^\d+$/.test(lastWord)) {
        qty = parseInt(lastWord, 10);
        searchText = words.slice(0, -1).join(' ').trim();
      } else {
        searchText = line.trim();
        qty = 1;
      }
      if (searchText) {
        // Preserve original text for description search; also expose a compact part-number form
        items.push({
          part_number: searchText.toUpperCase(),
          raw_query: searchText,
          description: null,
          qty,
          needsLookup: true
        });
      }
    }
  }
  return items;
}

// Fill missing descriptions from the price_lookup view
async function enrichDescriptions(items) {
  const needParts = items.filter(i => i.needsLookup).map(i => i.part_number).filter(Boolean);
  if (needParts.length === 0) return items;

  const { data } = await supabase
    .from('price_lookup')
    .select('part_number, description')
    .in('part_number', needParts);

  const descMap = {};
  (data || []).forEach(r => { descMap[r.part_number] = r.description; });

  return items.map(item => ({
    ...item,
    description: item.description || descMap[item.part_number] || item.part_number
  }));
}

// ─── Customer helpers ────────────────────────────────────────────────────────
async function getOrCreateCustomer(msg) {
  const telegramId = msg.from.id;
  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Unknown';
  const username = msg.from.username || null;

  const { data: existing } = await supabase
    .from('customers')
    .select('id')
    .eq('telegram_id', telegramId)
    .single();

  if (existing) return existing.id;

  const { data: created } = await supabase
    .from('customers')
    .insert({ telegram_id: telegramId, name, username, source: 'Telegram' })
    .select('id')
    .single();

  return created?.id;
}

// ─── Save quotation ──────────────────────────────────────────────────────────
async function saveQuotation(customerId, chatId, quoteNumber, items, total, hasTbd) {
  // If any item has multiple matches, store pending selections in notes
  const pending = items
    .filter(i => i.matches && i.matches.length > 1)
    .map(i => ({ raw_query: i.raw_query, qty: i.qty, matches: i.matches }));
  const notes = pending.length ? JSON.stringify({ pending }) : null;

  const { data: quotation } = await supabase
    .from('quotations')
    .insert({
      quote_number: quoteNumber,
      customer_id: customerId,
      telegram_chat_id: chatId,
      total_amount: total,
      has_tbd: hasTbd,
      status: 'pending',
      notes
    })
    .select('id')
    .single();

  if (!quotation) return null;

  const rows = items.map(item => ({
    quotation_id: quotation.id,
    part_number: item.part_number,
    description: item.description,
    qty: item.qty,
    unit_price: item.unit_price ?? null,
    subtotal: item.subtotal ?? null,
    price_source: item.price_source ?? 'tbd'
  }));

  await supabase.from('quotation_items').insert(rows);
  return quotation.id;
}

// ─── Session helpers (guided /new quote flow) ───────────────────────────
async function getSession(telegramId) {
  const { data } = await supabase.from('bot_sessions')
    .select('*').eq('telegram_id', telegramId).limit(1);
  return (data && data[0]) || null;
}
async function setSession(telegramId, state, data) {
  await supabase.from('bot_sessions').upsert({
    telegram_id: telegramId, state,
    data: data || {},
    updated_at: new Date().toISOString()
  }, { onConflict: 'telegram_id' });
}
async function clearSession(telegramId) {
  await supabase.from('bot_sessions').delete().eq('telegram_id', telegramId);
}

function renderCart(items) {
  if (!items.length) return '_(empty)_';
  return items.map((it, i) =>
    `${i + 1}. \`${it.part_number}\`${it.description ? ' — ' + it.description : ''}  × ${it.qty}`
  ).join('\n');
}

// Load customer's latest pending-selection quotation
async function getPendingSelection(telegramId) {
  const { data: customer } = await supabase
    .from('customers')
    .select('id')
    .eq('telegram_id', telegramId)
    .single();
  if (!customer) return null;

  const { data: quotes } = await supabase
    .from('quotations')
    .select('id, quote_number, notes, created_at')
    .eq('customer_id', customer.id)
    .eq('status', 'pending')
    .not('notes', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (!quotes || !quotes.length) return null;
  try {
    return { quotation: quotes[0], data: JSON.parse(quotes[0].notes) };
  } catch { return null; }
}

// ─── Notify sales ────────────────────────────────────────────────────────────
async function notifySales(bot, salesChatId, quoteNumber, customerName, text) {
  if (!salesChatId) return;
  const notice = `🔔 *New Enquiry — ${quoteNumber}*\nFrom: ${customerName}\n\n${text}`;
  try {
    await bot.sendMessage(salesChatId, notice, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Failed to notify sales:', e.message);
  }
}

// ─── Bot setup ───────────────────────────────────────────────────────────────
function setupHandler(bot) {
  const salesChatId = () => process.env.SALES_CHAT_ID;
  const isSales = (msg) => String(msg.chat.id) === String(salesChatId());

  // /start
  bot.onText(/\/start/, (msg) => {
    const extra = isSales(msg) ? `\n\n${SALES_HELP}` : '';
    bot.sendMessage(msg.chat.id, HELP_TEXT + extra, { parse_mode: 'Markdown' });
  });

  // /help
  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown' });
  });

  // /myquotes — customer checks their own recent quotations
  bot.onText(/\/myquotes/, async (msg) => {
    const telegramId = msg.from.id;
    const { data: customer } = await supabase
      .from('customers')
      .select('id')
      .eq('telegram_id', telegramId)
      .single();

    if (!customer) {
      bot.sendMessage(msg.chat.id, 'No quotations found. Send us your enquiry to get started!');
      return;
    }

    const { data: quotes } = await supabase
      .from('quotations')
      .select('quote_number, total_amount, has_tbd, status, created_at')
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .limit(5);

    if (!quotes || quotes.length === 0) {
      bot.sendMessage(msg.chat.id, 'No quotations found yet.');
      return;
    }

    const statusEmoji = { pending: '⏳', won: '✅', lost: '❌' };
    let lines = ['📋 *Your Recent Quotations:*', ''];
    quotes.forEach(q => {
      const date = new Date(q.created_at).toLocaleDateString('en-GB');
      const amount = q.has_tbd ? 'TBD' : `RM ${parseFloat(q.total_amount).toFixed(2)}`;
      lines.push(`${statusEmoji[q.status] || '•'} *${q.quote_number}* — ${amount} — ${date}`);
    });
    lines.push('', '_Contact us to follow up on any quotation._');
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // ── Sales-only commands ────────────────────────────────────────────────────

  // /remind
  bot.onText(/\/remind/, async (msg) => {
    if (!isSales(msg)) return;
    await sendFollowUpReminder(bot, salesChatId());
  });

  // /stats — today's summary
  bot.onText(/\/stats/, async (msg) => {
    if (!isSales(msg)) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { data } = await supabase
      .from('quotations')
      .select('status, total_amount, has_tbd')
      .gte('created_at', today.toISOString());

    const all = data || [];
    const won = all.filter(q => q.status === 'won');
    const revenue = won.reduce((s, q) => s + (parseFloat(q.total_amount) || 0), 0);
    const lines = [
      `📊 *Today's Summary — ${today.toLocaleDateString('en-GB')}*`,
      '',
      `Total Enquiries: *${all.length}*`,
      `Won: *${won.length}*  |  Pending: *${all.filter(q => q.status === 'pending').length}*  |  Lost: *${all.filter(q => q.status === 'lost').length}*`,
      `Revenue: *RM ${revenue.toFixed(2)}*`
    ];
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /pending — list pending quotes
  bot.onText(/\/pending/, async (msg) => {
    if (!isSales(msg)) return;
    const { data } = await supabase
      .from('quotations')
      .select('quote_number, total_amount, has_tbd, created_at, customers(name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(10);

    if (!data || data.length === 0) {
      bot.sendMessage(msg.chat.id, '✅ No pending quotations.');
      return;
    }
    let lines = [`⏳ *Pending Quotations (${data.length}):*`, ''];
    data.forEach((q, i) => {
      const amount = q.has_tbd ? 'TBD' : `RM ${parseFloat(q.total_amount).toFixed(2)}`;
      const date = new Date(q.created_at).toLocaleDateString('en-GB');
      lines.push(`${i + 1}. *${q.quote_number}* | ${q.customers?.name || 'Unknown'} | ${amount} | ${date}`);
    });
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /price PARTNO — check price of a specific part
  bot.onText(/\/price (.+)/, async (msg, match) => {
    if (!isSales(msg)) return;
    const partNumber = match[1].trim().toUpperCase();
    const { data } = await supabase
      .from('products')
      .select('part_number, source, description, unit_price, stock_qty, updated_at')
      .eq('part_number', partNumber)
      .order('source');

    if (!data || data.length === 0) {
      bot.sendMessage(msg.chat.id, `❌ Part *${partNumber}* not found in any price source.`, { parse_mode: 'Markdown' });
      return;
    }

    const srcLabel = { excel: '📊 Excel', external: '🔗 External', manual: '✏️ Manual' };
    const priority = { excel: 1, external: 2, manual: 3 };
    const sorted = [...data].sort((a, b) => priority[a.source] - priority[b.source]);
    const active = sorted[0];

    let lines = [`🔍 *${partNumber}*`, `_${active.description}_`, ''];
    sorted.forEach(r => {
      const isActive = r.source === active.source ? ' ← *active*' : '';
      lines.push(`${srcLabel[r.source] || r.source}: *RM ${parseFloat(r.unit_price).toFixed(2)}* | Stock: ${r.stock_qty}${isActive}`);
    });
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // ── Main message handler ──────────────────────────────────────────────────
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const raw = msg.text.trim();

    // Check for letter-selection pattern: "A", "a", "A 2", "A,B,C"
    const letterMatch = raw.match(/^([A-Za-z])(?:\s+(\d+))?$/);
    const multiLetterMatch = raw.match(/^([A-Za-z](?:\s*[,+\s]\s*[A-Za-z])+)$/);

    try {
      if (letterMatch || multiLetterMatch) {
        const pending = await getPendingSelection(msg.from.id);
        if (!pending || !pending.data.pending?.length) {
          bot.sendMessage(chatId, '⚠️ No pending selections found. Please send your part number or search query first.');
          return;
        }

        // Resolve each letter → actual part
        const letters = letterMatch
          ? [{ letter: letterMatch[1].toUpperCase(), qty: parseInt(letterMatch[2], 10) || null }]
          : raw.split(/[,+\s]+/).filter(Boolean).map(l => ({ letter: l.toUpperCase(), qty: null }));

        const pendingGroup = pending.data.pending[0]; // most recent multi-match group
        const resolved = [];
        for (const { letter, qty } of letters) {
          const idx = letter.charCodeAt(0) - 65;
          if (idx < 0 || idx >= pendingGroup.matches.length) {
            bot.sendMessage(chatId, `⚠️ Invalid letter "${letter}". Available: A–${String.fromCharCode(64 + pendingGroup.matches.length)}.`);
            return;
          }
          const match = pendingGroup.matches[idx];
          resolved.push({
            part_number: match.part_number,
            description: match.description,
            qty: qty ?? pendingGroup.qty ?? 1,
            unit_price: match.unit_price,
            price_source: match.price_source,
            matches: [match]
          });
        }

        // Mark previous pending quotation as superseded
        await supabase.from('quotations').update({ notes: null, status: 'lost' }).eq('id', pending.quotation.id);

        const quoteNumber = await generateQuoteNumber();
        const { text, total, hasTbd } = buildQuotationText(quoteNumber, resolved);
        await bot.sendMessage(chatId, `✅ *Selection confirmed!*\n\n${text}`, { parse_mode: 'Markdown' });

        const customerId = await getOrCreateCustomer(msg);
        await saveQuotation(customerId, chatId, quoteNumber, resolved, total, hasTbd);

        const customerName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Unknown';
        await notifySales(bot, salesChatId(), quoteNumber, customerName, text);
        return;
      }

      // Normal flow — parse as items
      const rawItems = parseItems(raw);
      if (rawItems.length === 0) {
        bot.sendMessage(chatId, HELP_TEXT, { parse_mode: 'Markdown' });
        return;
      }

      const enriched = await enrichDescriptions(rawItems);
      const pricedItems = await lookupPrices(enriched);
      const quoteNumber = await generateQuoteNumber();
      const { text, total, hasTbd } = buildQuotationText(quoteNumber, pricedItems);

      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });

      const customerId = await getOrCreateCustomer(msg);
      await saveQuotation(customerId, chatId, quoteNumber, pricedItems, total, hasTbd);

      const customerName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Unknown';
      await notifySales(bot, salesChatId(), quoteNumber, customerName, text);
    } catch (err) {
      console.error('Bot error:', err);
      bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again or contact us directly.');
    }
  });
}

// ─── Direct message handler (for webhook/serverless) ────────────────────────
// Processes a Telegram update synchronously so we can await completion
// before returning from the webhook — necessary on Vercel.
async function processUpdate(bot, update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const salesChatId = process.env.SALES_CHAT_ID;
  const isSales = String(msg.chat.id) === String(salesChatId);

  try {
    // ── Guided-quote commands (/new, /done, /cancel) ───────────────
    const session = await getSession(msg.from.id);

    if (text === '/new' || text === '/quote') {
      await setSession(msg.from.id, 'awaiting_part', { items: [] });
      await bot.sendMessage(chatId,
        `📝 *NEW QUOTE — ITEM 1*\n\n` +
        `Please reply with the *PART NUMBER*:\n\n` +
        `_Example: 45022-S9A-A01N1_\n\n` +
        `• Type /cancel anytime to stop`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (text === '/cancel') {
      if (session) {
        await clearSession(msg.from.id);
        await bot.sendMessage(chatId, '❌ Quote cancelled.');
      } else {
        await bot.sendMessage(chatId, '_No active quote to cancel. Type /new to start._', { parse_mode: 'Markdown' });
      }
      return;
    }

    if (text === '/done') {
      if (!session || !session.data?.items?.length) {
        await bot.sendMessage(chatId, '_No items added yet. Type /new to start a quote._', { parse_mode: 'Markdown' });
        return;
      }
      const cartItems = session.data.items.map(it => ({
        part_number: it.part_number,
        raw_query: it.raw_query || it.part_number,
        description: it.description || null,
        qty: it.qty || 1,
        needsLookup: !it.description
      }));
      await clearSession(msg.from.id);

      const enriched = await enrichDescriptions(cartItems);
      const pricedItems = await lookupPrices(enriched);
      const quoteNumber = await generateQuoteNumber();
      const { text: qText, total, hasTbd } = buildQuotationText(quoteNumber, pricedItems);
      await bot.sendMessage(chatId, qText, { parse_mode: 'Markdown' });

      const customerId = await getOrCreateCustomer(msg);
      await saveQuotation(customerId, chatId, quoteNumber, pricedItems, total, hasTbd);
      const customerName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Unknown';
      await notifySales(bot, salesChatId, quoteNumber, customerName, qText);
      return;
    }

    // ── Session-state routing (user is filling the form) ────────────
    if (session && !text.startsWith('/')) {
      const data = session.data || { items: [] };
      const itemNum = (data.items?.length || 0) + 1;

      if (session.state === 'awaiting_part') {
        data.current = { part_number: text.toUpperCase(), raw_query: text };
        await setSession(msg.from.id, 'awaiting_desc', data);
        await bot.sendMessage(chatId,
          `✓ Part #${itemNum}: \`${text}\`\n\n` +
          `Now reply with the *DESCRIPTION*:\n\n` +
          `_Example: Brake Pad Front_\n\n` +
          `• Reply \`-\` to skip (we'll auto-fill from catalog)\n` +
          `• Type /cancel to stop`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (session.state === 'awaiting_desc') {
        data.current.description = (text.trim() === '-' || text.trim() === '') ? null : text.trim();
        await setSession(msg.from.id, 'awaiting_qty', data);
        await bot.sendMessage(chatId,
          `✓ Description: ${data.current.description || '_(auto-fill from catalog)_'}\n\n` +
          `Now reply with the *QTY*:\n\n` +
          `_Example: 2_\n\n` +
          `• Reply \`-\` or empty for qty 1\n` +
          `• Type /cancel to stop`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (session.state === 'awaiting_qty') {
        const qty = parseInt(text.replace(/[^0-9]/g, ''), 10) || 1;
        data.current.qty = qty;
        data.items = data.items || [];
        data.items.push(data.current);
        data.current = null;
        await setSession(msg.from.id, 'awaiting_part', data);

        await bot.sendMessage(chatId,
          `✅ Item ${data.items.length} added!\n\n` +
          `*🛒 Current cart (${data.items.length} item${data.items.length > 1 ? 's' : ''}):*\n` +
          `${renderCart(data.items)}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `*ITEM ${data.items.length + 1}* — reply with *PART NUMBER* to add another\n\n` +
          `• /done – generate quotation\n` +
          `• /cancel – abort`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
    }

    // ── Commands ─────────────────────────────────────────────────
    if (text === '/start' || text === '/help') {
      const extra = (text === '/start' && isSales) ? `\n\n${SALES_HELP}` : '';
      await bot.sendMessage(chatId, HELP_TEXT + extra, { parse_mode: 'Markdown' });
      return;
    }

    if (text === '/myquotes') {
      const { data: customer } = await supabase
        .from('customers').select('id').eq('telegram_id', msg.from.id).single();
      if (!customer) {
        await bot.sendMessage(chatId, 'No quotations found. Send us your enquiry to get started!');
        return;
      }
      const { data: quotes } = await supabase
        .from('quotations')
        .select('quote_number, total_amount, has_tbd, status, created_at')
        .eq('customer_id', customer.id)
        .order('created_at', { ascending: false })
        .limit(5);
      if (!quotes || quotes.length === 0) {
        await bot.sendMessage(chatId, 'No quotations found yet.');
        return;
      }
      const statusEmoji = { pending: '⏳', won: '✅', lost: '❌' };
      let lines = ['📋 *Your Recent Quotations:*', ''];
      quotes.forEach(q => {
        const date = new Date(q.created_at).toLocaleDateString('en-GB');
        const amount = q.has_tbd ? 'TBD' : `RM ${parseFloat(q.total_amount).toFixed(2)}`;
        lines.push(`${statusEmoji[q.status] || '•'} *${q.quote_number}* — ${amount} — ${date}`);
      });
      lines.push('', '_Contact us to follow up on any quotation._');
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    if (isSales && text === '/remind') {
      await sendFollowUpReminder(bot, salesChatId);
      return;
    }

    if (isSales && text === '/stats') {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const { data } = await supabase
        .from('quotations').select('status, total_amount, has_tbd')
        .gte('created_at', today.toISOString());
      const all = data || [];
      const won = all.filter(q => q.status === 'won');
      const revenue = won.reduce((s, q) => s + (parseFloat(q.total_amount) || 0), 0);
      const lines = [
        `📊 *Today's Summary — ${today.toLocaleDateString('en-GB')}*`, '',
        `Total Enquiries: *${all.length}*`,
        `Won: *${won.length}*  |  Pending: *${all.filter(q => q.status === 'pending').length}*  |  Lost: *${all.filter(q => q.status === 'lost').length}*`,
        `Revenue: *RM ${revenue.toFixed(2)}*`
      ];
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    if (isSales && text === '/pending') {
      const { data } = await supabase
        .from('quotations')
        .select('quote_number, total_amount, has_tbd, created_at, customers(name)')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(10);
      if (!data || data.length === 0) {
        await bot.sendMessage(chatId, '✅ No pending quotations.');
        return;
      }
      let lines = [`⏳ *Pending Quotations (${data.length}):*`, ''];
      data.forEach((q, i) => {
        const amount = q.has_tbd ? 'TBD' : `RM ${parseFloat(q.total_amount).toFixed(2)}`;
        const date = new Date(q.created_at).toLocaleDateString('en-GB');
        lines.push(`${i + 1}. *${q.quote_number}* | ${q.customers?.name || 'Unknown'} | ${amount} | ${date}`);
      });
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    const priceMatch = text.match(/^\/price\s+(.+)$/i);
    if (isSales && priceMatch) {
      const partNumber = priceMatch[1].trim().toUpperCase();
      const { data } = await supabase
        .from('products')
        .select('part_number, source, description, unit_price, stock_qty, updated_at')
        .eq('part_number', partNumber).order('source');
      if (!data || data.length === 0) {
        await bot.sendMessage(chatId, `❌ Part *${partNumber}* not found in any price source.`, { parse_mode: 'Markdown' });
        return;
      }
      const srcLabel = { excel: '📊 Excel', external: '🔗 External', manual: '✏️ Manual' };
      const priority = { excel: 1, external: 2, manual: 3 };
      const sorted = [...data].sort((a, b) => priority[a.source] - priority[b.source]);
      const active = sorted[0];
      let lines = [`🔍 *${partNumber}*`, `_${active.description}_`, ''];
      sorted.forEach(r => {
        const isActive = r.source === active.source ? ' ← *active*' : '';
        lines.push(`${srcLabel[r.source] || r.source}: *RM ${parseFloat(r.unit_price).toFixed(2)}* | Stock: ${r.stock_qty}${isActive}`);
      });
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return;
    }

    if (text.startsWith('/')) return; // unknown command, ignore

    // ── Letter selection? ─────────────────────────────────────────
    const letterMatch = text.match(/^([A-Za-z])(?:\s+(\d+))?$/);
    const multiLetterMatch = text.match(/^([A-Za-z](?:\s*[,+\s]\s*[A-Za-z])+)$/);

    if (letterMatch || multiLetterMatch) {
      const pending = await getPendingSelection(msg.from.id);
      if (!pending || !pending.data.pending?.length) {
        await bot.sendMessage(chatId, '⚠️ No pending selections found. Please send your part number or search query first.');
        return;
      }
      const letters = letterMatch
        ? [{ letter: letterMatch[1].toUpperCase(), qty: parseInt(letterMatch[2], 10) || null }]
        : text.split(/[,+\s]+/).filter(Boolean).map(l => ({ letter: l.toUpperCase(), qty: null }));

      const pendingGroup = pending.data.pending[0];
      const resolved = [];
      for (const { letter, qty } of letters) {
        const idx = letter.charCodeAt(0) - 65;
        if (idx < 0 || idx >= pendingGroup.matches.length) {
          await bot.sendMessage(chatId, `⚠️ Invalid letter "${letter}". Available: A–${String.fromCharCode(64 + pendingGroup.matches.length)}.`);
          return;
        }
        const m = pendingGroup.matches[idx];
        resolved.push({
          part_number: m.part_number,
          description: m.description,
          qty: qty ?? pendingGroup.qty ?? 1,
          unit_price: m.unit_price,
          price_source: m.price_source,
          matches: [m]
        });
      }

      await supabase.from('quotations').update({ notes: null, status: 'lost' }).eq('id', pending.quotation.id);
      const quoteNumber = await generateQuoteNumber();
      const { text: qText, total, hasTbd } = buildQuotationText(quoteNumber, resolved);
      await bot.sendMessage(chatId, `✅ *Selection confirmed!*\n\n${qText}`, { parse_mode: 'Markdown' });
      const customerId = await getOrCreateCustomer(msg);
      await saveQuotation(customerId, chatId, quoteNumber, resolved, total, hasTbd);
      const customerName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Unknown';
      await notifySales(bot, salesChatId, quoteNumber, customerName, qText);
      return;
    }

    // ── Natural-language fallback ─────────────────────────────────
    // If the user typed an English sentence (presence of common stop words),
    // redirect them to /new rather than doing a lossy keyword search.
    const STOP_WORDS = new Set([
      'i','want','need','needs','looking','look','lookin','search','searching',
      'find','finding','please','pls','plz','can','could','would','should',
      'you','u','have','has','having','get','getting','a','an','the','this',
      'that','these','those','me','my','mine','for','with','to','do','does',
      'any','got','is','are','was','were','there','hi','hello','hey','help',
      'ask','asking','show','give','know','tell','available','avail','stock',
      'how','what','when','where','which','who','why'
    ]);
    const lowerWords = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const stopHits = lowerWords.filter(w => STOP_WORDS.has(w)).length;
    const hasPipe = text.includes('|');
    // Require 2+ stop words to avoid false positives on queries like
    // "DISC ROTOR FOR CIVIC" (only "for" is a stop word).
    const looksLikeSentence = !hasPipe && stopHits >= 2 && lowerWords.length >= 3;
    if (looksLikeSentence) {
      await bot.sendMessage(chatId,
        `👋 Looks like you're asking in a sentence.\n\n` +
        `For accurate pricing, please type /new and I'll guide you field by field:\n` +
        `  1️⃣ PART NUMBER\n` +
        `  2️⃣ DESCRIPTION\n` +
        `  3️⃣ QTY\n\n` +
        `Or send it directly like:\n` +
        `\`ABC123 | Brake Pad | 2\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ── Normal item query ─────────────────────────────────────────
    const rawItems = parseItems(text);
    if (rawItems.length === 0) {
      await bot.sendMessage(chatId, HELP_TEXT, { parse_mode: 'Markdown' });
      return;
    }
    const enriched = await enrichDescriptions(rawItems);
    const pricedItems = await lookupPrices(enriched);
    const quoteNumber = await generateQuoteNumber();
    const { text: qText, total, hasTbd } = buildQuotationText(quoteNumber, pricedItems);
    await bot.sendMessage(chatId, qText, { parse_mode: 'Markdown' });

    // If anything came back unmatched, suggest the guided form
    if (hasTbd) {
      await bot.sendMessage(chatId,
        `💡 _Some items didn't match. Try /new to enter part number, description, and qty step by step._`,
        { parse_mode: 'Markdown' }
      );
    }

    const customerId = await getOrCreateCustomer(msg);
    await saveQuotation(customerId, chatId, quoteNumber, pricedItems, total, hasTbd);
    const customerName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Unknown';
    await notifySales(bot, salesChatId, quoteNumber, customerName, qText);
  } catch (err) {
    console.error('[processUpdate] error:', err.message, err.stack);
    try { await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again or contact us directly.'); } catch {}
  }
}

// ─── Follow-up reminder ───────────────────────────────────────────────────────
async function sendFollowUpReminder(bot, chatId) {
  if (!chatId) return;

  const { data: overdue } = await supabase
    .from('quotations')
    .select('quote_number, total_amount, has_tbd, follow_up_due, customers(name)')
    .eq('status', 'pending')
    .lt('follow_up_due', new Date().toISOString())
    .order('follow_up_due', { ascending: true })
    .limit(10);

  if (!overdue || overdue.length === 0) {
    bot.sendMessage(chatId, '✅ No overdue follow-ups right now.');
    return;
  }

  const now = Date.now();
  let lines = ['🔔 *FOLLOW-UP ALERT*', ''];
  overdue.forEach((q, i) => {
    const days = Math.floor((now - new Date(q.follow_up_due).getTime()) / 86400000);
    const amount = q.has_tbd ? 'TBD' : `RM ${parseFloat(q.total_amount).toFixed(2)}`;
    lines.push(`${i + 1}. *${q.quote_number}* | ${q.customers?.name || 'Unknown'} | ${amount} | ${days}d overdue`);
  });
  lines.push('', '_Open the dashboard to update status._');

  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

module.exports = { setupHandler, sendFollowUpReminder, processUpdate };
