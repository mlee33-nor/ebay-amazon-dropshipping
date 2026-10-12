# Dropship Ledger

Profit dashboard for an eBay ← Amazon dropshipping partnership. eBay sales come from the eBay API,
Amazon costs come from Amazon emails (automatic), Amazon CSV exports, or the monthly settlement sheet,
and the Settlement page produces the monthly "eBay partner sends Amazon partner" number.

## How the numbers work

- **Item profit** (per sale) = what the buyer paid (excl. sales tax) − eBay fees − ad fees − Amazon cost − refunds + Amazon refunds − other costs.
- **Net business profit** = item profit − monthly operating costs (subscriptions, proxies, tools…).
- **Settlement**: the Amazon partner is reimbursed Amazon COGS (+ any expenses they paid) plus their profit share;
  the eBay partner sends that amount. Reproduces the monthly sheets to the cent (`test/settlement.test.js`).
- A sale with **no linked Amazon purchase is never counted** (shown as "awaiting cost"), and an Amazon order that
  isn't linked to a sale is **never counted**, so personal purchases can't leak into profit.

### Payments and pay periods

- From September 2026 each payment covers the **27th of the previous month through the 26th** (Arizona time) and is due on
  the 26th. July and August 2026 were calendar months.
- Each transfer is recorded on the Settlements page as **its own payment** (Add a payment / Pay the remaining). A later
  payment, like a missed sale paid separately, never overwrites the first; a mistake can be removed or corrected with a
  negative amount.
- **A payment closes its period.** The first payment records every line the period covered and its amounts, the
  operating costs and the split. Nothing that happens afterwards changes a closed period: a late refund, a late ad fee,
  a sale costed later, an edited cost or a cost added late goes on the **next open payment** as its own line
  ("Refund ·", "Change after the … payment ·"), and the closed one keeps what was paid ("Held as paid").
- eBay's REFUND records are net of the fees eBay gives back; return holds (DISPUTE_HOLD) are not losses until refunded
  (a hold never released after 30 days is flagged); ad fees eBay gives back and return labels are booked on the payment
  for the day they happen.
- Hand-kept monthly sheets are a **check**, not an input, from October 2026: uploading one shows every line next to the
  site with the reason for each difference, and never changes the books. A paid month is never rewritten.
- Every manual change to money (payments, costs, overrides, links, settings) is logged (`GET /api/log`), and
  `GET /api/export/backup` downloads everything as one JSON file. Download one after each payment.

## Where the data comes from

| Source | How | When |
|---|---|---|
| eBay sales, fees, ad fees, refunds, returns, tracking | eBay Fulfillment + Finances + Post-Order APIs | Automatically every 30 min (`SYNC_INTERVAL_MINUTES`), plus the **Sync** button |
| Amazon purchases | IMAP read of emails **from amazon.com** (order confirmations, cancellations, refunds) | Automatically every 30 min, first check 15 s after the server starts, plus **Check email now** |
| Amazon purchases (backup/backfill) | CSV upload: Amazon Business report, Request-Your-Data, Order History Reporter extension | Whenever you upload |
| Past months | Monthly settlement sheet CSV (same upload box, auto-detected) | Whenever you upload |
| Operating costs | From the sheets, or Editor → Operating expenses | Whenever you edit |

Nothing needs to be re-enabled. The scheduler runs inside the server process, so it runs as long as the Railway
service is up. Each email check looks back 3 days from the last successful check (first run: `EMAIL_BACKFILL_DAYS`),
skips emails it has already seen, and a red banner appears on every page if eBay or email syncing fails or goes stale.

### Matching Amazon purchases to eBay sales

Amazon's emails only contain the order number, total, date, category and **"FirstName - CITY, ST"**. They do
not contain the product name, ASIN, zip or tracking. A purchase auto-links to a sale only when:

- the buyer's first name **and** city **and** state match the eBay ship-to (or zip / last name / tracking from a CSV), and
- the purchase is within 1 day before to 7 days after the sale, and
- the Amazon total is a believable cost for that sale (20%–105% of what the buyer paid), and
- no other sale is a close alternative (**ambiguity guard**). Ambiguous cases go to Editor → Match review.

Links can be reviewed and undone (order drawer → Unlink, or Editor → Amazon purchases).
Dedupe: Amazon rows are keyed by **Amazon order number**, so overlapping CSVs and repeated emails never double-count,
and a CSV row for an order replaces the email-derived row for the same order.

## Tests

```bash
sh scripts/test-all.sh            # every suite below, in order (TEST_PG_OFFSET=100 to run beside another checkout)
sh scripts/install-hooks.sh       # once per clone: git push refuses to push unless every suite passes (Railway deploys on push)
npm test                          # parser, matcher, settlement vs the real sheets
npm run test:e2e                  # mock eBay API -> real sync -> Amazon email -> match -> profit, then deletes itself
node scripts/stress-test.js 7 worst       # 320 sales, 12 names x 8 cities, decoys, cancels, refunds; must be 0 wrong links
node scripts/stress-test.js 7 realistic
```

## Setup

1. **Supabase**: create a project → Project Settings → Database → Connection string → *Session pooler* URI → `DATABASE_URL`.
   Tables are created automatically on first start.
2. **eBay**: developer.ebay.com → Application Keys → Production: `EBAY_CLIENT_ID` (App ID), `EBAY_CLIENT_SECRET` (Cert ID),
   and `EBAY_REFRESH_TOKEN` (issued to that same App ID; lasts ~18 months).
3. **Email**: `EMAIL_USER` = the Gmail address that receives the Amazon order emails; `EMAIL_PASSWORD` = a Gmail
   **App Password** (myaccount.google.com/apppasswords, needs 2-Step Verification). App passwords don't expire.
   Alternative: set `INBOUND_TOKEN` and POST emails to `/api/email/inbound` from Zapier/Make/Apps Script.
4. **Railway**: New project → Deploy from this GitHub repo → Variables: everything from `.env.example`, plus
   `DASHBOARD_PASSWORD` and `SESSION_SECRET` (any long random string). Railway runs `scripts/start.sh` and health-checks `/api/health`.
5. **Ask AI model (optional)**: Claude, through Anthropic's API. Railway Variables: `ANTHROPIC_API_KEY` = an API key from
   console.anthropic.com → API keys (it starts `sk-ant-api03-`; make it inside a workspace, or also set
   `ANTHROPIC_WORKSPACE_ID`). `ANTHROPIC_MODEL` picks the model (default `claude-sonnet-5-5`; `claude-haiku-5-5` is cheaper
   and faster). The question **and the figures behind the answer** are sent to Anthropic. The model reads each question
   and writes a line about the dashboard's own answer; a line with any number that isn't in the dashboard's figures is
   dropped. Without a key, Ask AI works with its built-in reader. The deploy log says "Anthropic reachable, using ..."
   when the key works.

Local: `npm install`, copy `.env.example` to `.env`, `npm run dev`. With no `DATABASE_URL` it runs an embedded Postgres in `./.localdb`.
