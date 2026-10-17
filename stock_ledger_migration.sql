-- Stock ledger (17 Oct 2026). Run in the Supabase SQL editor BEFORE pushing the code that uses it. Safe to run twice.
-- Idea: nobody types a total. Every receipt, sale, damage and count is one row in stock_movements; stock on hand is the sum.
-- Mistakes are reversed with a REVERSAL row, never edited or deleted.

create table if not exists stock_items (
  slug        text primary key,
  name        text not null,
  kind        text not null check (kind in ('product','packaging')),
  unit        text not null default 'pcs',
  low_level   integer not null default 0 check (low_level >= 0),   -- at or below this the item shows LOW (0 = only the manual Low flag)
  manual_low  boolean not null default false,                     -- anyone can flag "running low" with one tap
  active      boolean not null default true,
  sort        integer not null default 100,
  created_at  timestamptz not null default now()
);

create table if not exists stock_movements (
  id           bigserial primary key,
  item_slug    text not null references stock_items(slug),
  qty          integer not null check (qty <> 0),                 -- + in, - out
  type         text not null check (type in ('RECEIVE','DAMAGED','SALE','SALE_UNDO','USE','SAMPLE','RETURN','COUNT_FIX','REVERSAL')),
  lot_code     text,
  best_before  date,
  ref          text,                                              -- supplier challan/invoice no., or "<order id>@<time>" for a sale
  note         text,
  actor_email  text,
  actor_name   text,
  reverses_id  bigint references stock_movements(id),
  billed_kg    numeric(10,3),                                     -- optional, on a RECEIVE: weight Krazy Bakers billed (they charge by the kg)
  amount_paise bigint,                                            -- optional, on a RECEIVE: amount billed, for the money ledger later
  created_at   timestamptz not null default now()
);
create index if not exists stock_movements_item_idx on stock_movements (item_slug, created_at desc);
-- a sale line can be written only once per order pack, and a movement can be reversed only once
create unique index if not exists stock_movements_sale_once on stock_movements (ref, item_slug, coalesce(lot_code, ''), type) where type in ('SALE', 'SALE_UNDO');
create unique index if not exists stock_movements_reverse_once on stock_movements (reverses_id) where reverses_id is not null;

create table if not exists stock_settings (key text primary key, value text);
-- Sales are deducted automatically only for orders packed after this moment (earlier orders left before the first lot arrived).
insert into stock_settings (key, value) values ('tracking_from', now()::text) on conflict (key) do nothing;

create or replace view stock_by_lot as
  select item_slug, lot_code, best_before, sum(qty)::int as qty
  from stock_movements group by item_slug, lot_code, best_before;

alter table stock_items enable row level security;      -- no public policies: only the backend's service key can read or write
alter table stock_movements enable row level security;
alter table stock_settings enable row level security;

insert into stock_items (slug, name, kind, unit, low_level, sort) values
  ('atta-kesari',     'Atta Kesari',          'product',   'boxes',   30, 10),
  ('atta-original',   'Atta Original',        'product',   'boxes',   30, 11),
  ('atta-ajwain',     'Atta Ajwain',          'product',   'boxes',   30, 12),
  ('atta-lite-sugar', 'Atta Sugar-Lite',      'product',   'boxes',   30, 13),
  ('mono-original',   'Mono carton: Original','packaging', 'cartons',  0, 20),
  ('mono-kesari',     'Mono carton: Kesari',  'packaging', 'cartons',  0, 21),
  ('mono-ajwain',     'Mono carton: Ajwain',  'packaging', 'cartons',  0, 22),
  ('mono-lite-sugar', 'Mono carton: Sugar-Lite','packaging','cartons', 0, 23),
  ('mailer-3box',     '3-box mailer',         'packaging', 'mailers',  0, 30),
  ('mailer-4box',     '4-box mailer',         'packaging', 'mailers',  0, 31),
  ('case-carton',     '20-box case carton',   'packaging', 'cartons',  0, 32),
  ('packing-tape',    'Packing tape',         'packaging', 'rolls',    0, 33),
  ('filler',          'Filler / paper',       'packaging', 'packs',    0, 34),
  ('label-address',   'Address labels',       'packaging', 'labels',   0, 40),
  ('label-stamp',     'Stamp / batch labels', 'packaging', 'labels',   0, 41),
  ('slip',            'Packing slips',        'packaging', 'slips',    0, 42),
  ('card',            'Greeting cards',       'packaging', 'cards',    0, 43)
on conflict (slug) do nothing;

-- Read-back: expect 17 items, 0 movements, 1 setting, and the view to exist.
select (select count(*) from stock_items) as items, (select count(*) from stock_movements) as movements,
       (select value from stock_settings where key = 'tracking_from') as tracking_from,
       (select count(*) from information_schema.views where table_name = 'stock_by_lot') as view_exists;
