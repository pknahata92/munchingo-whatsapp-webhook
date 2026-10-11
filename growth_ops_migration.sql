-- Growth + operations bundle: marketing consent, abandoned-checkout and review nudges,
-- replacement orders, batch / best-before records.
-- Safe to run more than once. Run it in the Supabase SQL editor BEFORE deploying any code that uses it
-- (rule: migration first, code second). Nothing in the live code reads these columns yet, so running it
-- early changes no behaviour. Order STATUS is left alone, as in every earlier migration.
-- After running, the read-back query at the bottom should list every column / table named here.

-- 1. Marketing consent (DPDP Act). Promotional WhatsApp/email only goes to numbers with an explicit opt-in.
--    The order row keeps what the customer ticked at checkout (an unticked box = false = no marketing).
--    customer_prefs (one row per phone, already holds the language) holds the LIVE state, so a STOP reply
--    from WhatsApp can switch it off without touching old orders.
alter table orders add column if not exists marketing_opt_in boolean not null default false;

alter table customer_prefs add column if not exists marketing_opt_in     boolean not null default false;
alter table customer_prefs add column if not exists marketing_opt_in_at  timestamptz;
alter table customer_prefs add column if not exists marketing_opt_out_at timestamptz;
alter table customer_prefs add column if not exists consent_source       text;   -- 'checkout' | 'whatsapp' | 'admin'

-- 2. One-time nudges. A timestamp means "already sent", so a nudge can never go out twice.
alter table orders add column if not exists checkout_nudge_at timestamptz;   -- abandoned payment reminder
alter table orders add column if not exists review_nudge_at   timestamptz;   -- feedback / reorder ask after delivery

-- Partial indexes so the hourly nudge queries stay instant however many orders there are.
create index if not exists orders_checkout_nudge_idx on orders (created_at)
  where status = 'pending_payment' and checkout_nudge_at is null;
create index if not exists orders_review_nudge_idx on orders (delivered_at)
  where delivered_at is not null and review_nudge_at is null;

-- 3. Replacement orders: a zero-value order linked to the order it replaces (damaged / wrong item),
--    shipped through the same To pack > Packed > Shipped > Delivered steps.
alter table orders add column if not exists replaces_order_id  text;
alter table orders add column if not exists replacement_reason text;
create index if not exists orders_replaces_idx on orders (replaces_order_id) where replaces_order_id is not null;

-- 4. Batch / lot and best-before (needed for the pack label and for any recall).
create table if not exists batches (
  id            bigserial primary key,
  code          text not null unique,                -- e.g. KB-ORIG-1020
  product_slug  text,                                -- atta-original | atta-kesari | atta-ajwain | atta-lite-sugar
  produced_on   date,
  best_before   date not null,
  qty_made      integer,                             -- boxes in the run, optional
  notes         text,
  active        boolean not null default true,       -- inactive = no longer offered when packing
  created_by    text,
  created_at    timestamptz not null default now()
);
create index if not exists batches_product_idx on batches (product_slug, active);
alter table batches enable row level security;       -- no public policies: only the backend's service key can read it

-- Which batch codes went into an order, written when it is marked packed:
-- [{"slug":"atta-original","code":"KB-ORIG-1020","best_before":"2027-01-18"}, ...]
alter table orders add column if not exists batch_codes jsonb;

-- Read-back: expect 4 rows from the first query, 1 from the second, 1 from the third (the batches table).
select table_name, column_name from information_schema.columns
  where (table_name = 'orders' and column_name in ('marketing_opt_in','checkout_nudge_at','review_nudge_at','replaces_order_id','replacement_reason','batch_codes'))
     or (table_name = 'customer_prefs' and column_name in ('marketing_opt_in','marketing_opt_in_at','marketing_opt_out_at','consent_source'))
  order by table_name, column_name;
select count(*) as batches_table_exists from information_schema.tables where table_name = 'batches';
select tablename, rowsecurity from pg_tables where tablename = 'batches';
