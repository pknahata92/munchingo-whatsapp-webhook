-- Selling prices controlled from the admin (Prices screen). Safe to run more than once.
-- Running this is what switches the shop to the prices below: until it runs, the server keeps using the built-in
-- list in utils/catalog.js (259 / 299 / 739 / 999). After it runs, the admin owns the prices.
create table if not exists product_prices (
  slug        text primary key,                 -- atta-original, atta-kesari, atta-lite-sugar, atta-ajwain, trio-gift-set, full-range-set
  price       integer not null check (price > 0),   -- what the customer pays per unit, GST included, in rupees
  mrp         integer check (mrp is null or mrp >= price),  -- printed MRP shown struck through when above the price (null = no strike-through)
  updated_by  text,
  updated_at  timestamptz not null default now()
);
alter table product_prices enable row level security;   -- no public policies: only the backend's service key can read it

create table if not exists product_price_history (
  id          bigserial primary key,
  slug        text not null,
  old_price   integer,
  new_price   integer not null,
  old_mrp     integer,
  new_mrp     integer,
  changed_by  text,
  changed_at  timestamptz not null default now()
);
alter table product_price_history enable row level security;

-- Launch pricing: boxes at MRP, gift sets unchanged.
insert into product_prices (slug, price, mrp, updated_by) values
  ('atta-original',   300, 300, 'migration'),
  ('atta-ajwain',     300, 300, 'migration'),
  ('atta-kesari',     350, 350, 'migration'),
  ('atta-lite-sugar', 350, 350, 'migration'),
  ('trio-gift-set',   739, null, 'migration'),
  ('full-range-set',  999, 1300, 'migration')
on conflict (slug) do nothing;
