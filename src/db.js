// Database layer. Production: Postgres via DATABASE_URL (Supabase connection string).
// Local dev with no DATABASE_URL: embedded PostgreSQL in ./.localdb
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Load .env for local runs (Railway injects env vars directly)
try { process.loadEnvFile?.(path.join(ROOT, '.env')); } catch {}

// DATE columns come back as the stored 'YYYY-MM-DD' text. Turned into a JS Date they mean UTC midnight, which an
// Arizona reader sees as the day before (a payment on Oct 26 would read as Oct 25).
pg.types.setTypeParser(1082, (v) => v);

let impl = null; // the main account (MDBIZ MAIN)

// ---- accounts. Each eBay store is an account with its own Postgres schema (sales, costs, payments, settings, its own
// eBay connection and Amazon inbox). Every query runs against the account of the request it serves: the server wraps
// each request (and each background sync) in withAccount(id, ...), and q() picks that account's connection. Code
// that never names an account works on the main one, exactly as before accounts existed.
export const MAIN = 'main';
const als = new AsyncLocalStorage();
const extra = new Map(); // account id -> connection, for accounts other than the main one
let poolConf = null; // how to open another account's connection: { url, ssl, base }
export const currentAccount = () => als.getStore() || MAIN;
export const withAccount = (id, fn) => als.run(id || MAIN, fn);
export const accountIds = () => [MAIN, ...extra.keys()];
export const hasAccount = (id) => id === MAIN || extra.has(id);
function cur() {
  const a = currentAccount();
  const c = a === MAIN ? impl : extra.get(a);
  if (!c) throw new Error(`Unknown account: ${a}`);
  return c;
}
// Module state that belongs to one account (an eBay token, a sync in progress): one copy per account
export function accountState(init) {
  const m = new Map();
  return () => { const a = currentAccount(); if (!m.has(a)) m.set(a, init()); return m.get(a); };
}
// A setting from the environment for the current account: EMAIL_USER for the main one, EMAIL_USER_<ID> for another
export function accountEnv(name) {
  const a = currentAccount();
  return a === MAIN ? process.env[name] : process.env[`${name}_${a.toUpperCase()}`];
}

const SCHEMA = `
create table if not exists ebay_orders (
  order_id           text primary key,
  created_at         timestamptz not null,
  buyer_username     text,
  ship_name          text,
  ship_city          text,
  ship_state         text,
  ship_zip           text,
  ship_country       text,
  fulfillment_status text,
  payment_status     text,
  cancel_state       text,
  item_subtotal      numeric(12,2) default 0,
  shipping_charged   numeric(12,2) default 0,
  discount           numeric(12,2) default 0,
  tax_collected      numeric(12,2) default 0,
  revenue            numeric(12,2) default 0,
  ebay_fees          numeric(12,2) default 0,
  ad_fees            numeric(12,2) default 0,
  refund_total       numeric(12,2) default 0,
  tracking_numbers   text[] default '{}',
  tracking_fetched   boolean default false,
  raw                jsonb,
  synced_at          timestamptz default now()
);
create index if not exists ebay_orders_created_idx on ebay_orders(created_at);

create table if not exists ebay_line_items (
  line_item_id   text primary key,
  order_id       text not null references ebay_orders(order_id) on delete cascade,
  legacy_item_id text,
  sku            text,
  title          text,
  quantity       int default 1,
  unit_price     numeric(12,2) default 0,
  line_total     numeric(12,2) default 0
);
create index if not exists ebay_line_items_order_idx on ebay_line_items(order_id);

create table if not exists ebay_returns (
  return_id     text primary key,
  order_id      text,
  item_id       text,
  state         text,
  status        text,
  reason        text,
  return_type   text,
  created_at    timestamptz,
  refund_amount numeric(12,2) default 0,
  raw           jsonb,
  synced_at     timestamptz default now()
);
create index if not exists ebay_returns_order_idx on ebay_returns(order_id);

create table if not exists amazon_imports (
  id              serial primary key,
  filename        text,
  uploaded_at     timestamptz default now(),
  format          text,
  rows_in_file    int default 0,
  lines_new       int default 0,
  lines_updated   int default 0,
  lines_unchanged int default 0,
  orders_in_file  int default 0,
  orders_linked   int default 0
);

-- One row per Amazon order line. line_key = amazon order id | asin (or title) | occurrence,
-- so re-uploading overlapping weeks updates rows instead of duplicating them.
create table if not exists amazon_lines (
  line_key        text primary key,
  amazon_order_id text not null,
  order_date      date,
  asin            text,
  title           text,
  quantity        int default 1,
  unit_price      numeric(12,2),
  item_subtotal   numeric(12,2),
  tax             numeric(12,2),
  shipping        numeric(12,2),
  discount        numeric(12,2),
  line_total      numeric(12,2) default 0,
  ship_name       text,
  ship_address    text,
  ship_zip        text,
  ship_state      text,
  order_status    text,
  tracking        text,
  payment         text,
  raw             jsonb,
  first_import    int,
  last_import     int,
  cost_override   numeric(12,2),
  ignored         boolean default false,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index if not exists amazon_lines_order_idx on amazon_lines(amazon_order_id);
create index if not exists amazon_lines_date_idx on amazon_lines(order_date);

-- Only Amazon orders that appear here ever touch the numbers. Everything else is ignored.
create table if not exists order_links (
  amazon_order_id text primary key,
  ebay_order_id   text not null,
  method          text,
  score           numeric,
  reasons         text,
  created_at      timestamptz default now()
);
create index if not exists order_links_ebay_idx on order_links(ebay_order_id);

create table if not exists link_rejections (
  amazon_order_id text not null,
  ebay_order_id   text not null,
  created_at      timestamptz default now(),
  primary key (amazon_order_id, ebay_order_id)
);

create table if not exists order_overrides (
  order_id        text primary key,
  cost_override   numeric(12,2),
  extra_cost      numeric(12,2),
  amazon_refund   numeric(12,2),
  fee_override    numeric(12,2),
  refund_override numeric(12,2),
  notes           text,
  excluded        boolean default false,
  updated_at      timestamptz default now()
);

create table if not exists settings (
  key   text primary key,
  value jsonb
);

-- Every eBay Finances money record, stored once by transaction id, so per-order fees/ad fees/refunds are
-- always the sum of ALL records (a later sync window can never wipe an earlier charge or credit)
create table if not exists ebay_transactions (
  transaction_id  text primary key,
  order_id        text,
  type            text,
  fee_type        text,
  booking_entry   text,
  amount          numeric(12,2) default 0,
  fee_amount      numeric(12,2) default 0,
  transaction_at  timestamptz,
  raw             jsonb
);
create index if not exists ebay_transactions_order_idx on ebay_transactions(order_id);
alter table ebay_orders add column if not exists fee_credit numeric(12,2) default 0;
alter table order_overrides add column if not exists confirmed_separate boolean default false;

create table if not exists sync_log (
  id          serial primary key,
  started_at  timestamptz default now(),
  finished_at timestamptz,
  ok          boolean,
  message     text,
  orders      int default 0,
  returns     int default 0
);
create table if not exists ledger_entries (
  entry_key      text primary key,
  month          text not null,
  row_no         int,
  row_count      int,
  title          text,
  amazon_cost    numeric(12,2) default 0,
  sale_price     numeric(12,2) default 0,
  ad_fees        numeric(12,2) default 0,
  sheet_net      numeric(12,2),
  note           text,
  is_refund      boolean default false,
  manual         boolean default false,
  ebay_order_id  text,
  match_method   text,
  source_file    text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create index if not exists ledger_entries_month_idx on ledger_entries(month);

create table if not exists expenses (
  id         serial primary key,
  month      text not null,
  category   text not null,
  amount     numeric(12,2) not null default 0,
  note       text,
  paid_by    text default 'seller',
  source     text default 'manual',
  updated_at timestamptz default now(),
  unique (month, category)
);

create table if not exists settlements (
  month      text primary key,
  paid       numeric(12,2),
  paid_at    date,
  note       text,
  updated_at timestamptz default now()
);
-- Every payment Drew makes (or a correction, as a negative amount). settlements.paid is their sum and paid_at the
-- latest date, so a second payment (e.g. a missed sale paid later) never overwrites the first.
create table if not exists settlement_payments (
  id          serial primary key,
  month       text not null,
  amount      numeric(12,2) not null,
  paid_at     date,
  note        text,
  recorded_at timestamptz default now()
);
-- A payment, once made, is closed: the rows it covered are recorded here when its first payment is entered. Anything
-- that turns up later for that period goes on the next unpaid payment, so a paid payment never changes.
create table if not exists settlement_freeze (
  month     text primary key,
  frozen_at timestamptz not null default now(),
  row_keys  jsonb not null,
  totals    jsonb,
  source    text
);
-- Each covered row's money when the payment was made (cents): a later change to it (a late ad fee, an edited cost)
-- becomes an adjustment on the next open payment instead of changing the paid one
alter table settlement_freeze add column if not exists row_values jsonb;
-- Every manual change to money (payments, costs, expenses, links, settings, uploads): who/when/what, before and after
create table if not exists money_log (
  id      serial primary key,
  at      timestamptz not null default now(),
  action  text not null,
  subject text,
  before  jsonb,
  after   jsonb,
  ip      text,
  agent   text
);

alter table amazon_lines add column if not exists source text default 'csv';
create table if not exists amazon_emails (
  message_id   text primary key,
  received_at  timestamptz,
  subject      text,
  kind         text,
  order_ids    text[],
  ok           boolean,
  note         text,
  parsed       jsonb,
  created_at   timestamptz default now()
);
-- An email that failed to read is read again on later syncs (attempts, and once more after a parser change);
-- dismissed = someone has dealt with it, so it stops warning
alter table amazon_emails add column if not exists attempts int default 1;
alter table amazon_emails add column if not exists parser_version int;
alter table amazon_emails add column if not exists dismissed boolean default false;
create table if not exists amazon_refunds (
  message_id      text not null,
  amazon_order_id text not null,
  amount          numeric(12,2) not null,
  received_at     timestamptz,
  primary key (message_id, amazon_order_id)
);
-- the item named in the refund email ("Refund issued for <item>"), used to match refunds for purchases this inbox never saw
alter table amazon_refunds add column if not exists title text;
-- the refund the email states; amount is what is counted (capped so an order's refunds never exceed its cost)
alter table amazon_refunds add column if not exists email_amount numeric(12,2);
create index if not exists amazon_refunds_order_idx on amazon_refunds(amazon_order_id);
-- eBay listing analytics (src/listings.js)
create table if not exists ebay_listings (
  item_id            text primary key,
  title              text,
  sku                text,
  price              numeric(12,2),
  currency           text,
  quantity           int,
  quantity_available int,
  quantity_sold      int default 0,
  start_time         timestamptz,
  listing_url        text,
  listing_type       text,
  watch_count        int,
  hit_count          int,
  first_seen         timestamptz default now(),
  last_seen          timestamptz default now(),
  ended              boolean default false,
  ended_at           timestamptz
);
create index if not exists ebay_listings_ended_idx on ebay_listings(ended);
create table if not exists listing_snapshots (
  day            date primary key,
  active_count   int not null default 0,
  total_watchers int default 0,
  total_views    int,
  views_source   text,
  avg_price      numeric(12,2),
  units_sold     int default 0,
  taken_at       timestamptz default now()
);
create table if not exists listing_traffic_daily (
  day          date primary key,
  impressions  int,
  views        int,
  ctr          numeric(10,4),
  conversion   numeric(10,4),
  transactions int,
  synced_at    timestamptz default now()
);
create table if not exists listing_traffic (
  item_id      text primary key,
  period_start date,
  period_end   date,
  impressions  int,
  views        int,
  ctr          numeric(10,4),
  conversion   numeric(10,4),
  transactions int,
  synced_at    timestamptz default now()
);
-- Promoted Listings (src/promotions.js)
create table if not exists ebay_campaigns (
  campaign_id    text primary key,
  name           text,
  status         text,
  funding_model  text,
  bid_percentage numeric(6,2),
  rules_based    boolean default false,
  start_date     timestamptz,
  end_date       timestamptz,
  synced_at      timestamptz default now()
);
create table if not exists listing_ads (
  listing_id     text not null,
  campaign_id    text not null,
  ad_id          text,
  ad_status      text,
  bid_percentage numeric(6,2),
  synced_at      timestamptz default now(),
  primary key (listing_id, campaign_id)
);
create index if not exists listing_ads_campaign_idx on listing_ads(campaign_id);
`;

export async function initDb() {
  if (process.env.DATABASE_URL) {
    const url = process.env.DATABASE_URL;
    const local = /localhost|127\.0\.0\.1/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      ssl: local ? false : { rejectUnauthorized: false },
      max: 5,
    });
    // Keep every table in its own schema so the app can share a Supabase project with other apps safely
    const schema = (process.env.DB_SCHEMA || 'dropship').replace(/[^a-z0-9_]/gi, '');
    poolConf = { url, ssl: local ? false : { rejectUnauthorized: false }, base: schema };
    pool.on('connect', (client) => {
      client.query(`create schema if not exists ${schema}; set search_path to ${schema}, public`).catch((e) => console.error('schema setup failed', e.message));
    });
    impl = {
      kind: 'postgres',
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
      client: () => pool.connect(),
      close: () => pool.end(),
    };
  } else if (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is not set. Add your Supabase Session pooler connection string in Railway -> Variables.');
  } else {
    // Local dev: a real embedded PostgreSQL (crash-safe) in ./.localdb on a private port.
    // If another local process already started it (server + a script), just connect to it.
    const port = Number(process.env.LOCAL_PG_PORT || 5439);
    const url = `postgres://postgres:local@127.0.0.1:${port}/postgres`;
    let embedded = null;
    if (!(await canConnect(url))) {
      const { default: EmbeddedPostgres } = await import('embedded-postgres');
      const dir = process.env.LOCAL_PG_DIR || path.join(ROOT, '.localdb');
      embedded = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'local', port, persistent: true, onLog: () => {}, onError: () => {} });
      if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await embedded.initialise();
      const pid = path.join(dir, 'postmaster.pid');
      if (fs.existsSync(pid)) fs.rmSync(pid); // stale lock left by a hard kill; the port check above proved nothing is running
      await embedded.start();
    }
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    poolConf = { url, ssl: false, base: 'acct' }; // the main account uses public here; others get acct_<id>
    impl = {
      kind: 'local-postgres',
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
      client: () => pool.connect(),
      close: async () => { await pool.end(); if (embedded) await embedded.stop(); },
    };
  }
  await impl.exec(SCHEMA);
  // Payments recorded before the payments table existed become one payment each (the note keeps any split)
  await impl.query(`insert into settlement_payments (month, amount, paid_at, note)
    select s.month, s.paid, s.paid_at, coalesce(s.note, 'recorded before payments were itemised') from settlements s
    where s.paid is not null and not exists (select 1 from settlement_payments p where p.month = s.month)`);
  // eBay's extra columns (refs, hold ids, per-step sync status) are added here too, so the money pages that read them
  // work before the first eBay sync after a deploy
  await (await import('./ebay.js')).ensureEbaySchema(true);
  // The other accounts (registered in the main schema) each get their own connection and tables
  await impl.exec('create table if not exists accounts (id text primary key, name text not null, created_at timestamptz not null default now())');
  for (const { id } of (await impl.query('select id from accounts order by created_at')).rows) await openAccount(id);
  return impl.kind;
}

async function openAccount(id) {
  if (extra.has(id)) return;
  const schema = `${poolConf.base}_${id}`.replace(/[^a-z0-9_]/gi, '');
  const pool = new pg.Pool({ connectionString: poolConf.url, ssl: poolConf.ssl, max: 3 });
  pool.on('connect', (client) => {
    client.query(`create schema if not exists ${schema}; set search_path to ${schema}, public`).catch((e) => console.error('schema setup failed', e.message));
  });
  const c = { kind: impl.kind, schema, query: (text, params) => pool.query(text, params), exec: (text) => pool.query(text), client: () => pool.connect(), close: () => pool.end() };
  extra.set(id, c);
  await withAccount(id, async () => {
    await c.exec(SCHEMA);
    await (await import('./ebay.js')).ensureEbaySchema(true);
  });
}

// Every account, the main one first: [{ id, name }]
export async function listAccounts() {
  return withAccount(MAIN, async () => {
    const rows = await q('select id, name from accounts order by created_at');
    return [{ id: MAIN, name: (await getSetting('account_name')) || 'MDBIZ MAIN' }, ...rows];
  });
}
export async function createAccount(name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!clean) throw new Error('Give the account a name');
  return withAccount(MAIN, async () => {
    const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'store';
    const taken = new Set([MAIN, 'all', ...(await q('select id from accounts')).map((r) => r.id)]);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
    await q('insert into accounts (id, name) values ($1, $2)', [id, clean]);
    await openAccount(id);
    return { id, name: clean };
  });
}
export async function renameAccount(id, name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!clean) throw new Error('Give the account a name');
  return withAccount(MAIN, async () => {
    if (id === MAIN) await setSetting('account_name', clean);
    else if (!(await q('update accounts set name = $2 where id = $1 returning id', [id, clean])).length) throw new Error('No such account');
    return { id, name: clean };
  });
}

async function canConnect(url) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

export async function closeDb() {
  for (const c of extra.values()) await c.close().catch(() => {});
  extra.clear();
  await impl?.close?.();
}

export function dbKind() {
  return impl?.kind;
}

// Run several statements as one: all of them happen or none do, and other readers never see a half-done state
export async function withTransaction(fn) {
  const client = await cur().client();
  try {
    await client.query('begin');
    const out = await fn(async (text, params = []) => (await client.query(text, params)).rows);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function q(text, params = []) {
  const res = await cur().query(text, params);
  return res.rows;
}

export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

export async function getSetting(key, fallback = null) {
  const row = await one('select value from settings where key = $1', [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await q(
    `insert into settings (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)]
  );
}

export const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
