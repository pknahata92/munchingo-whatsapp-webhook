-- Munchingo "Subscribe & Save" — run once in the Supabase SQL editor.
--
-- This is the "Subscribe & Remind" model, NOT true autopay: each cycle
-- generates a fresh Razorpay payment link and notifies the customer —
-- they still tap to pay each time. Chosen over real Razorpay
-- Subscriptions/UPI Autopay (a mandate-based zero-click charge) because
-- there's no proven repeat-purchase volume yet to justify that heavier
-- build (Subscriptions API, mandate authorization UX, dunning logic for
-- failed auto-charges). See CLAUDE.md's 2026-09-01 session log for the
-- full reasoning. Upgrade to true autopay once this proves people actually
-- want it.

create table if not exists subscriptions (
  id                bigint generated always as identity primary key,
  customer_phone    text not null,
  customer_name     text not null,
  customer_email    text not null,        -- REQUIRED, not optional like on a normal order.
                                           -- WhatsApp free-text renewal reminders fail outside
                                           -- a 24h customer-initiated session window (no
                                           -- Meta-approved template exists for this message
                                           -- yet) -- email is the one reliable channel here,
                                           -- WhatsApp is sent too but only best-effort.
  delivery_address  text not null,
  items             jsonb not null,       -- [{slug, name, unit, quantity}] -- price is NEVER
                                           -- stored here; recomputed live from utils/catalog.js
                                           -- every cycle so a future price change is honoured
                                           -- automatically, and sold-out items are caught.
  discount_pct      numeric not null default 8,
  frequency_days    integer not null default 30,
  status            text not null default 'active' check (status in ('active','paused','cancelled')),
  next_order_date   date not null,
  last_order_id     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_subscriptions_due on subscriptions (status, next_order_date);
create index if not exists idx_subscriptions_phone on subscriptions (customer_phone);

alter table subscriptions enable row level security;
-- No policies added on purpose -- service role only, same posture as
-- orders/coupons. Never reachable via the anon key.

-- Tag which orders came from a subscription renewal, so the daily digest,
-- owner email, and order history can tell at a glance.
alter table orders add column if not exists subscription_id bigint references subscriptions(id);
