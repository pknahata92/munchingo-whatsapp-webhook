-- Munchingo coupon system — run this once in the Supabase SQL editor
-- before the coupon code (utils/coupons.js, routes/checkout.js) goes live.
-- Matches the existing `orders` table's RLS posture: service-role only,
-- no public policies, so the anon key (used nowhere server-side anyway)
-- can never read or write these tables.

create table if not exists coupons (
  code                   text primary key,           -- always stored/matched uppercase
  type                   text not null check (type in ('flat', 'percent')),
  value                  numeric not null,             -- rupees if flat, percent (e.g. 5) if percent
  min_order_value        numeric not null default 0,
  scope_slug             text,                         -- null = applies to any order; else cart must include this slug (e.g. 'full-range-set')
  max_uses               integer,                      -- null = unlimited
  uses_count             integer not null default 0,
  max_uses_per_customer  integer default 1,             -- null = unlimited per customer
  expires_at             timestamptz,
  active                 boolean not null default true,
  created_at             timestamptz not null default now()
);

create table if not exists coupon_redemptions (
  id               bigint generated always as identity primary key,
  coupon_code      text not null references coupons(code),
  customer_phone   text not null,
  order_id         text not null,
  discount_amount  numeric not null,
  redeemed_at      timestamptz not null default now()
);

create index if not exists idx_coupon_redemptions_code_phone on coupon_redemptions (coupon_code, customer_phone);

alter table coupons enable row level security;
alter table coupon_redemptions enable row level security;
-- No policies added on purpose — service role bypasses RLS entirely, and
-- nothing here should ever be reachable via the anon key.

-- Optional columns on the existing orders table, so a discounted order
-- shows the coupon and discount on the order record itself (owner email,
-- daily digest, etc. already just read whatever's on the row).
alter table orders add column if not exists coupon_code text;
alter table orders add column if not exists discount_amount numeric;

-- ── Seed the two offers from the growth-strategy session ───────────────────
insert into coupons (code, type, value, min_order_value, scope_slug, max_uses, max_uses_per_customer, expires_at)
values
  ('FOUNDING100', 'flat', 100, 999, null, 200, 1, now() + interval '60 days')
on conflict (code) do nothing;

-- Diwali code: edit expires_at to the actual festive week before activating,
-- and flip active to true when you're ready to launch it (kept inactive by
-- default here so it doesn't go live by accident on migration day).
insert into coupons (code, type, value, min_order_value, scope_slug, max_uses, max_uses_per_customer, expires_at, active)
values
  ('DIWALI5FR', 'percent', 5, 0, 'full-range-set', null, 1, '2026-11-15T00:00:00Z', false)
on conflict (code) do nothing;
