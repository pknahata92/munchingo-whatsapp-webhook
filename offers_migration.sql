-- Offers v3 (Oct 2026): first-order-only codes, automatic stock-up tiers on single boxes, and the offer's name on an order.
-- Safe to run more than once. Run it in the Supabase SQL editor BEFORE pushing the backend that uses it.
-- The backend also works without it (no tiers, no "new customers only"), so the order is safe either way.

-- The four coupon-screen columns from coupons_admin_migration.sql, repeated so this one run covers everything.
alter table coupons add column if not exists note          text;
alter table coupons add column if not exists created_by    text;
alter table coupons add column if not exists starts_at     timestamptz;
alter table coupons add column if not exists allowed_phone text;

-- "New customers only": refused when this phone number already has a paid order.
alter table coupons add column if not exists first_order_only boolean not null default false;

-- Automatic stock-up tiers: spend at least min_singles (rupees, single boxes only) and save `discount` rupees.
create table if not exists spend_tiers (
  id          bigint generated always as identity primary key,
  min_singles numeric not null check (min_singles > 0),
  discount    numeric not null check (discount > 0),
  label       text,                         -- optional customer-facing name; default "Spend ₹X on single boxes"
  starts_at   timestamptz,                  -- null = live now
  ends_at     timestamptz,                  -- null = until paused
  active      boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now()
);
alter table spend_tiers enable row level security;   -- service role only, like coupons

-- Which automatic offer an order got (coupon orders keep using coupon_code).
alter table orders add column if not exists offer_label text;

-- Read-back: expect 5 coupon columns, 1 orders column, 1 table.
select table_name, column_name from information_schema.columns
 where (table_name = 'coupons' and column_name in ('note','created_by','starts_at','allowed_phone','first_order_only'))
    or (table_name = 'orders' and column_name = 'offer_label')
 order by table_name, column_name;
select to_regclass('public.spend_tiers') as spend_tiers_table;
