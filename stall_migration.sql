-- Stall tally storage (27 Oct 2026). Run in the Supabase SQL editor BEFORE pushing the code that uses it. Safe to run twice.
-- The stall page (munchingo.com/stall) sends the whole day to the backend after every change. One row per customer.
-- Buyers who tick the marketing box also go into `contacts` (first_source 'stall:<day>'); nothing about a buyer is stored without that tick.

create table if not exists stall_days (
  day         text primary key,                 -- IST day, e.g. 2026-10-27
  opening     jsonb not null default '{}',      -- opening stock count per flavor that morning
  updated_at  timestamptz not null default now()
);

create table if not exists stall_orders (
  id             text primary key,              -- id made on the iPad (time + random), so a resend never duplicates
  day            text not null references stall_days(day),
  customer_no    integer not null,
  sold_at        timestamptz not null,
  pay            text not null check (pay in ('upi', 'cash')),
  lines          jsonb not null,                -- [{item, name, price, hamper, mix}]
  total          integer not null,
  contact_phone  text,                          -- only when the buyer ticked the marketing box (links to contacts.phone)
  deleted_at     timestamptz,                   -- deleted or undone on the iPad (kept for the record)
  updated_at     timestamptz not null default now()
);
create index if not exists stall_orders_day_idx on stall_orders (day);
alter table stall_days   enable row level security;   -- no public policies: only the backend's service key can read or write
alter table stall_orders enable row level security;
