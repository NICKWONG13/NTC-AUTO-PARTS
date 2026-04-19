# NTC Auto Parts — Setup Guide

## Quick Start (5 steps)

### Step 1 — Install dependencies
```bash
npm install
```

### Step 2 — Create your .env file
```bash
copy .env.example .env
```
Open `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `TELEGRAM_TOKEN` | Message @BotFather → /newbot |
| `SALES_CHAT_ID` | Message @userinfobot in Telegram, copy the id |
| `SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `SUPABASE_KEY` | Supabase project → Settings → API → anon/public key |

### Step 3 — Set up the database
1. Go to your [Supabase project](https://supabase.com)
2. Click **SQL Editor** in the left sidebar
3. Copy the entire contents of `db/migration.sql`
4. Paste and click **Run**

### Step 4 — Verify setup
```bash
npm run check
```
This checks all environment variables and database tables. Fix any ❌ before continuing.

### Step 5 — Start the server
```bash
npm run dev
```
Open **http://localhost:3000** — the dashboard loads immediately.

---

## Telegram Bot Commands

### For customers:
| Command | Action |
|---|---|
| `/start` | Welcome message + format guide |
| `/help` | Show format guide |
| `/myquotes` | See their last 5 quotations |
| *(send items)* | Auto-generate quotation |

**Customer message format (any of these work):**
```
ABC123 | Brake Pad | 2          ← full format
ABC123 | 2                      ← part no. + qty (description from catalog)
ABC123                          ← part no. only (qty = 1)
```
Multiple items: one per line.

### For sales team (SALES_CHAT_ID only):
| Command | Action |
|---|---|
| `/stats` | Today's enquiries, won count, revenue |
| `/pending` | List of pending quotations |
| `/remind` | Send overdue follow-up list |
| `/price ABC123` | Check price from all sources |

---

## Dashboard Features

| Tab | Features |
|---|---|
| **Overview** | Quote counts (today/week/month), revenue, status chart, customer sources, overdue follow-ups, price change history, low stock alerts |
| **Follow-ups** | Overdue pending quotes with [Mark Won] [Mark Lost] [Telegram link] buttons |
| **Quotations** | Filter by status, view details, copy quotation text, update status |
| **Customers** | Source tracking, edit source per customer |
| **Products** | Excel upload status, external sync status, search bar, combined view with source priority badges |
| **Settings** | External API URL + key (with test connection), auto-sync interval, low stock threshold |

---

## Price Priority System

When a customer enquires about a part, the system checks in this order:

```
① Excel Stock File  →  ② External System  →  ③ Manual Entry  →  TBD
```

All three sources store prices separately. The highest-priority source wins.  
Price changes between syncs are automatically logged in the **Price Changes** panel.

---

## Deploy to Vercel

1. Push code to GitHub (`.env` is in `.gitignore` — never commit it)

2. Import the repo at [vercel.com](https://vercel.com)

3. Add these Environment Variables in Vercel dashboard:
   ```
   TELEGRAM_TOKEN=...
   SALES_CHAT_ID=...
   SUPABASE_URL=...
   SUPABASE_KEY=...
   NODE_ENV=production
   ```

4. After deploy, set the Telegram webhook:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-app.vercel.app/webhook/<TOKEN>"
   ```

5. Verify webhook is set:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
   ```

---

## Excel File Format

Upload any `.xlsx` file — column names are detected automatically.  
The system looks for columns containing keywords:

| Data | Detected keywords |
|---|---|
| Part Number | part, partno, partnumber, itemcode, code |
| Description | description, desc, name, item |
| Unit Price | price, unitprice, rate, cost, amt |
| Stock Qty | stock, qty, quantity, balance, onhand |

**Example:**
| Part No. | Description | Unit Price | Stock |
|---|---|---|---|
| ABC123 | Brake Pad Front | 45.00 | 50 |
| XYZ456 | Oil Filter | 25.00 | 0 |

---

## External System API Format

Your external system endpoint must return a JSON array:
```json
[
  { "part_number": "ABC123", "description": "Brake Pad", "unit_price": 45.00, "stock_qty": 50 },
  { "part_number": "XYZ456", "description": "Oil Filter", "unit_price": 25.00, "stock_qty": 0 }
]
```
Configure the URL and API key in **Dashboard → Settings**.
