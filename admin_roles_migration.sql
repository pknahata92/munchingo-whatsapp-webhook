-- Admin roles, order timeline, packed/delivered steps and the stock switch.
-- Safe to run more than once. Run it in the Supabase SQL editor BEFORE deploying the code that uses it.
-- Order STATUS is left alone ('paid' stays 'paid'); packed / shipped / delivered are the *_at columns,
-- so the daily summary, refunds and credit notes keep working exactly as before.

-- 1. Who may sign in, and with what powers. Env owners (ADMIN_EMAILS) always work even if this table is empty.
create table if not exists admin_users (
  email       text primary key,
  name        text,
  role        text not null check (role in ('owner', 'staff')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  text
);
alter table admin_users enable row level security;   -- no public policies: only the backend's service key can read it

insert into admin_users (email, name, role, created_by) values
  ('pk.nahata92@gmail.com',      'Prashant', 'owner', 'migration'),
  ('orders.munchingo@gmail.com', 'Orders',   'staff', 'migration')
on conflict (email) do nothing;

-- 2. Append-only timeline of everything done to an order.
create table if not exists order_events (
  id           bigserial primary key,
  order_id     text not null,
  event        text not null,
  from_state   text,
  to_state     text,
  actor_email  text,
  actor_name   text,
  meta         jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists order_events_order_idx on order_events (order_id, created_at);
alter table order_events enable row level security;

-- 3. The two new steps (shipped_at already exists from orders_admin_migration.sql).
alter table orders add column if not exists packed_at    timestamptz;
alter table orders add column if not exists packed_by    text;
alter table orders add column if not exists delivered_at timestamptz;
alter table orders add column if not exists delivered_by text;

-- 4. Sold-out switch per flavour. A flavour with no row, or available = true, is on sale.
create table if not exists product_stock (
  slug        text primary key,
  available   boolean not null default true,
  note        text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
alter table product_stock enable row level security;
insert into product_stock (slug) values ('atta-original'), ('atta-kesari'), ('atta-lite-sugar'), ('atta-ajwain')
on conflict (slug) do nothing;
