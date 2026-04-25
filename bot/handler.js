const supabase = require('../db/supabase');
const { generateQuoteNumber, buildQuotationText, lookupPrices } = require('./quotation');

// ─── Reliability wrapper ────────────────────────────────────────────────
// Patches bot.sendMessage once so that if Telegram rejects a Markdown
// message (malformed formatting, unbalanced brackets, reserved chars),
// we retry as plain text instead of silently failing. Prevents the
// whole class of "bot didn't reply" bugs.
function wrapBot(bot) {
  if (bot._ntcWrapped) return bot;
  const original = bot.sendMessage.bind(bot);
  bot.sendMessage = async (chatId, text, opts = {}) => {
    try {
      return await original(chatId, text, opts);
    } catch (e) {
      const desc = e?.response?.body?.description || e?.message || '';
      const isMarkdownIssue = opts.parse_mode &&
        /parse|entities|reserved|character|bad request|can.?t find/i.test(desc);
      if (!isMarkdownIssue) throw e;
      // Strip Markdown syntax and retry as plain text
      const plain = String(text).replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2');
      try {
        return await original(chatId, plain, { ...opts, parse_mode: undefined });
      } catch (e2) {
        console.error('[wrapBot] fallback also failed:', e2.message);
        throw e2;
      }
    }
  };
  bot._ntcWrapped = true;
  return bot;
}

// ─── Help text ────────────────────────────────────────────────────────────────
const HELP_TEXT = `👋 *Welcome to NTC Auto Parts!*
👋 *欢迎使用 NTC AUTO PARTS！*
👋 *Selamat datang ke NTC Auto Parts!*

*📝 Guided quote / 引导报价 / Sebut harga berpandu (recommended / 推荐 / disyorkan):*
Type /new — I'll walk you through step by step.
输入 /new — 我会一步步引导您填写。
Taip /new — saya akan bimbing anda langkah demi langkah.
  1️⃣  PART NUMBER  /  零件编号  /  NOMBOR ALAT GANTI
  2️⃣  DESCRIPTION  /  描述  /  KETERANGAN
  3️⃣  QUANTITY  /  数量  /  KUANTITI

*Quick format / 快速格式 / Format cepat (advanced / 进阶 / lanjutan):*
Send one item per line / 每行一个项目 / Satu item sebaris:
\`\`\`
ABC123 | Brake Pad | 2
XYZ456 | Oil Filter | 1
\`\`\`

*Commands / 指令 / Arahan:*
/new – guided quote / 开始引导报价 / sebut harga berpandu
/cart – review cart / 查看购物车 / lihat troli
/done – finish & generate quote / 完成并生成报价 / selesai & jana sebut harga
/cancel – abort / 取消 / batal
/myquotes – recent quotations / 查看历史报价 / sebut harga lalu`;

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
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getSession(telegramId) {
  const { data } = await supabase.from('bot_sessions')
    .select('*').eq('telegram_id', telegramId).limit(1);
  const row = (data && data[0]) || null;
  if (!row) return null;
  // Auto-expire stale sessions
  const age = Date.now() - new Date(row.updated_at).getTime();
  if (age > SESSION_TTL_MS) {
    await clearSession(telegramId);
    return null;
  }
  return row;
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
  return items.map((it, i) => {
    const part = it.part_number && it.part_number !== '?' ? `\`${it.part_number}\`` : '_(no part #)_';
    return `${i + 1}. ${part}${it.description ? ' — ' + it.description : ''}  × ${it.qty}`;
  }).join('\n');
}

// Quick-reply keyboards (tap instead of type)
const KB = {
  partStep:  { keyboard: [[{ text: '⏭ Skip part #' }], [{ text: '❌ /cancel' }]],
               resize_keyboard: true, one_time_keyboard: false },
  descStep:  { keyboard: [[{ text: '⏭ Skip description' }], [{ text: '❌ /cancel' }]],
               resize_keyboard: true, one_time_keyboard: false },
  qtyStep:   { keyboard: [[{ text: '1' }, { text: '2' }, { text: '4' }],
                          [{ text: '5' }, { text: '10' }, { text: '20' }],
                          [{ text: '❌ /cancel' }]],
               resize_keyboard: true, one_time_keyboard: false },
  addMore:   { keyboard: [[{ text: '✅ /done' }], [{ text: '🛒 /cart' }, { text: '❌ /cancel' }]],
               resize_keyboard: true, one_time_keyboard: false },
  remove:    { remove_keyboard: true }
};

// Map button-label presses to their real command
function normalizeButton(text) {
  const t = text.trim();
  if (t === '⏭ Skip part #' || t === '⏭ Skip description') return '-';
  if (t === '✅ /done')   return '/done';
  if (t === '❌ /cancel') return '/cancel';
  if (t === '🛒 /cart')   return '/cart';
  return text;
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
  const notice =
    `🔔 *New Enquiry — ${quoteNumber}*\n` +
    `From: ${customerName}\n\n` +
    `${text}`;
  try {
    await bot.sendMessage(salesChatId, notice, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  } catch (e) {
    console.error('Failed to notify sales:', e.message);
  }
}

// ─── Bot setup ───────────────────────────────────────────────────────────────
function setupHandler(bot) {
  wrapBot(bot);
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
  wrapBot(bot);
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const rawText = msg.text.trim();
  const text = normalizeButton(rawText);
  const salesChatId = process.env.SALES_CHAT_ID;
  const isSales = String(msg.chat.id) === String(salesChatId);

  try {
    // ── Guided-quote commands (/new, /done, /cancel, /cart) ───────────────
    const session = await getSession(msg.from.id);

    if (text === '/new' || text === '/quote') {
      // Cleanly reset if a stale session exists
      if (session) await clearSession(msg.from.id);
      await setSession(msg.from.id, 'awaiting_part', { items: [] });
      await bot.sendMessage(chatId,
        `📝 *NEW QUOTE — ITEM 1*\n` +
        `📝 *新报价 — 第 1 项*\n` +
        `📝 *SEBUT HARGA BARU — ITEM 1*\n\n` +
        `Please reply with the *PART NUMBER*\n` +
        `请输入*零件编号*\n` +
        `Sila balas dengan *NOMBOR ALAT GANTI*\n\n` +
        `_Example / 例如 / Contoh: 45022-S9A-A01N1_\n\n` +
        `• Tap *⏭ Skip part #* if unknown / 不知道编号请按跳过 / tekan langkau jika tidak tahu\n` +
        `• Tap *❌ /cancel* to stop / 取消 / batal`,
        { parse_mode: 'Markdown', reply_markup: KB.partStep }
      );
      return;
    }

    if (text === '/cancel') {
      if (session) {
        await clearSession(msg.from.id);
        await bot.sendMessage(chatId, '❌ Quote cancelled.  /  报价已取消。  /  Sebut harga dibatalkan.', { reply_markup: KB.remove });
      } else {
        await bot.sendMessage(chatId,
          '_No active quote to cancel. Type /new to start._\n' +
          '_目前没有进行中的报价。输入 /new 开始。_\n' +
          '_Tiada sebut harga aktif. Taip /new untuk mula._',
          { parse_mode: 'Markdown', reply_markup: KB.remove });
      }
      return;
    }

    if (text === '/cart') {
      if (!session || !session.data?.items?.length) {
        await bot.sendMessage(chatId,
          '🛒 _Your cart is empty. Type /new to start._\n' +
          '🛒 _购物车是空的。输入 /new 开始。_\n' +
          '🛒 _Troli kosong. Taip /new untuk mula._',
          { parse_mode: 'Markdown' });
        return;
      }
      await bot.sendMessage(chatId,
        `🛒 *Your cart  /  购物车  /  Troli  (${session.data.items.length} item${session.data.items.length > 1 ? 's' : ''}):*\n\n` +
        `${renderCart(session.data.items)}\n\n` +
        `• Reply with next *PART NUMBER* to add more\n` +
        `  输入下一个零件编号添加 / Balas dengan NOMBOR ALAT GANTI seterusnya\n` +
        `• Tap *✅ /done* — generate quote / 生成报价 / jana sebut harga\n` +
        `• Tap *❌ /cancel* — abort / 取消 / batal`,
        { parse_mode: 'Markdown', reply_markup: KB.addMore }
      );
      return;
    }

    if (text === '/done') {
      if (!session || !session.data?.items?.length) {
        await bot.sendMessage(chatId,
          '_No items added yet. Type /new to start a quote._\n' +
          '_还没有添加项目。输入 /new 开始报价。_\n' +
          '_Belum ada item. Taip /new untuk mula._',
          { parse_mode: 'Markdown', reply_markup: KB.remove });
        return;
      }
      const cartItems = session.data.items.map(it => ({
        part_number: it.part_number || '?',
        raw_query: it.raw_query || it.description || it.part_number,
        description: it.description || null,
        qty: it.qty || 1,
        needsLookup: !it.description
      }));
      await clearSession(msg.from.id);

      await bot.sendMessage(chatId,
        '⏳ _Generating your quotation… / 正在生成报价… / Menjana sebut harga…_',
        { parse_mode: 'Markdown', reply_markup: KB.remove });

      const enriched = await enrichDescriptions(cartItems);
      const pricedItems = await lookupPrices(enriched);
      const quoteNumber = await generateQuoteNumber();
      const { text: qText, total, hasTbd } = buildQuotationText(quoteNumber, pricedItems);
      await bot.sendMessage(chatId, qText, { parse_mode: 'Markdown' });
      await bot.sendMessage(chatId,
        `✅ _Quote saved. Our team will follow up shortly._\n` +
        `✅ _报价已保存，团队将很快跟进。_\n` +
        `✅ _Sebut harga disimpan. Pasukan kami akan susuli tidak lama lagi._\n\n` +
        `Type /new to start another / 输入 /new 开始下一个 / Taip /new untuk mula lagi`,
        { parse_mode: 'Markdown' });

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
        const skip = (text === '-' || text === '?' || text.toLowerCase() === 'unknown');
        if (!skip && text.length < 2) {
          await bot.sendMessage(chatId,
            '⚠️ Part number too short. Type again, or tap *⏭ Skip part #*.\n' +
            '⚠️ 零件编号太短，请重新输入，或按"跳过"。\n' +
            '⚠️ Nombor alat ganti terlalu pendek. Cuba lagi, atau tekan *⏭ Skip*.',
            { parse_mode: 'Markdown', reply_markup: KB.partStep });
          return;
        }
        data.current = skip
          ? { part_number: '?', raw_query: '', _noPart: true }
          : { part_number: text.toUpperCase(), raw_query: text };
        await setSession(msg.from.id, 'awaiting_desc', data);
        await bot.sendMessage(chatId,
          (skip
            ? `✓ Part #${itemNum}: _(no part number — please describe it next)_\n` +
              `  _无零件编号 — 请输入描述_\n` +
              `  _Tiada nombor — sila huraikan dalam langkah seterusnya_\n\n`
            : `✓ Part #${itemNum}: \`${text}\`\n\n`) +
          `Now reply with the *DESCRIPTION*\n` +
          `请输入*描述*\n` +
          `Sila balas dengan *KETERANGAN*\n\n` +
          `_Example / 例如 / Contoh: Brake Pad Front, Honda Civic FD_\n\n` +
          (skip
            ? `• Description is *required* / 必须填写描述 / Wajib diisi\n`
            : `• Tap *⏭ Skip description* — auto-fill from catalog / 按跳过自动填充 / langkau untuk autoisi\n`) +
          `• Tap *❌ /cancel* to stop / 取消 / batal`,
          { parse_mode: 'Markdown', reply_markup: KB.descStep }
        );
        return;
      }

      if (session.state === 'awaiting_desc') {
        const skip = (text === '-' || text === '');
        if (skip && data.current?._noPart) {
          await bot.sendMessage(chatId,
            '⚠️ Since you skipped the part number, please type a description.\n' +
            '⚠️ 您跳过了零件编号，请输入描述。\n' +
            '⚠️ Anda telah langkau nombor alat ganti — sila taip keterangan.',
            { parse_mode: 'Markdown', reply_markup: KB.descStep });
          return;
        }
        data.current.description = skip ? null : text.trim();
        delete data.current._noPart;
        await setSession(msg.from.id, 'awaiting_qty', data);
        await bot.sendMessage(chatId,
          `✓ Description / 描述 / Keterangan: ${data.current.description || '_(auto-fill / 自动填充 / autoisi)_'}\n\n` +
          `Now tap or reply with the *QTY*\n` +
          `请输入*数量*\n` +
          `Sila balas dengan *KUANTITI*\n\n` +
          `_Default 1 if blank / 留空默认 1 / Lalai 1 jika kosong_`,
          { parse_mode: 'Markdown', reply_markup: KB.qtyStep }
        );
        return;
      }

      if (session.state === 'awaiting_qty') {
        const qty = Math.max(1, parseInt(text.replace(/[^0-9]/g, ''), 10) || 1);
        data.current.qty = qty;
        data.items = data.items || [];
        data.items.push(data.current);
        data.current = null;
        await setSession(msg.from.id, 'awaiting_part', data);

        await bot.sendMessage(chatId,
          `✅ Item ${data.items.length} added!  /  已添加第 ${data.items.length} 项！  /  Item ${data.items.length} ditambah!\n\n` +
          `*🛒 Cart / 购物车 / Troli (${data.items.length}):*\n` +
          `${renderCart(data.items)}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +
          `*ITEM ${data.items.length + 1}* — reply with next *PART NUMBER*\n` +
          `*第 ${data.items.length + 1} 项* — 输入零件编号继续\n` +
          `*ITEM ${data.items.length + 1}* — balas NOMBOR ALAT GANTI seterusnya\n\n` +
          `• Tap *✅ /done* — generate quote / 生成报价 / jana sebut harga\n` +
          `• Tap *🛒 /cart* — review / 查看 / lihat\n` +
          `• Tap *❌ /cancel* — abort / 取消 / batal`,
          { parse_mode: 'Markdown', reply_markup: KB.addMore }
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

    if (isSales && text === '/version') {
      const sha = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 7);
      const msgIso = (process.env.VERCEL_GIT_COMMIT_MESSAGE || '').split('\n')[0].slice(0, 80);
      await bot.sendMessage(chatId,
        `🔧 *Build info*\n` +
        `Commit: \`${sha}\`\n` +
        `Message: ${msgIso || '_(n/a)_'}\n` +
        `Region: ${process.env.VERCEL_REGION || 'local'}\n` +
        `Time: ${new Date().toISOString()}`,
        { parse_mode: 'Markdown' });
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
        `👋 Looks like you're asking in a sentence.\n` +
        `👋 看起来您在用句子询问。\n` +
        `👋 Nampaknya anda menaip dalam ayat penuh.\n\n` +
        `For accurate pricing, type /new — I'll guide you field by field:\n` +
        `请输入 /new，我会逐栏引导您填写：\n` +
        `Taip /new — saya akan bimbing anda langkah demi langkah:\n` +
        `  1️⃣  PART NUMBER  /  零件编号  /  NOMBOR ALAT GANTI\n` +
        `  2️⃣  DESCRIPTION  /  描述  /  KETERANGAN\n` +
        `  3️⃣  QTY  /  数量  /  KUANTITI\n\n` +
        `Or send directly / 或直接发送 / Atau hantar terus:\n` +
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
        `💡 _Some items didn't match. Try /new to enter part #, description and qty step by step._\n` +
        `💡 _部分项目未匹配。试试 /new 一步步输入零件编号、描述和数量。_\n` +
        `💡 _Beberapa item tidak sepadan. Cuba /new untuk isi langkah demi langkah._`,
        { parse_mode: 'Markdown' }
      );
    }

    const customerId = await getOrCreateCustomer(msg);
    await saveQuotation(customerId, chatId, quoteNumber, pricedItems, total, hasTbd);
    const customerName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Unknown';
    await notifySales(bot, salesChatId, quoteNumber, customerName, qText);
  } catch (err) {
    console.error('[processUpdate] error:', err.message, err.stack);
    // Visible alert to sales so failures don't stay hidden in logs
    try {
      if (salesChatId) {
        await bot.sendMessage(salesChatId,
          `⚠️ Bot error — customer ${msg.from?.id}:\n${String(err.message || err).slice(0, 500)}`
        );
      }
    } catch {}
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
