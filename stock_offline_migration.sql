-- Offline sales and hampers (18 Oct 2026). Run in the Supabase SQL editor AFTER stock_ledger_migration.sql and BEFORE pushing the
-- code that uses it. Safe to run twice.

-- 1. Who bought it. For an offline sale, `ref` holds the invoice number and `party` the buyer.
alter table stock_movements add column if not exists party text;

-- 2. A new movement type: OFFLINE_SALE (bulk order, hamper or any sale that did not come through the website).
alter table stock_movements drop constraint if exists stock_movements_type_check;
alter table stock_movements add constraint stock_movements_type_check check (type in
  ('RECEIVE','DAMAGED','SALE','SALE_UNDO','USE','SAMPLE','GIFT','EXHIBITION','EXHIBITION_RETURN','OFFLINE_SALE','RETURN','COUNT_FIX','REVERSAL'));

-- 3. Hamper supplies (a hamper = transparent goodie bag + 3-4 biscuits + a candle + shredded paper).
insert into stock_items (slug, name, kind, unit, low_level, sort) values
  ('goodie-bag',      'Transparent goodie bags', 'packaging', 'bags',    0, 50),
  ('candle',          'Candles (for hampers)',   'packaging', 'candles', 0, 51),
  ('shredded-paper',  'Coloured shredded paper', 'packaging', 'packs',   0, 52)
on conflict (slug) do nothing;

-- 4. "Where did the stock go?": totals per item and type. A reversal is counted under the type of the line it cancels.
create or replace view stock_totals as
  select m.item_slug, coalesce(o.type, m.type) as type, sum(m.qty)::int as qty
  from stock_movements m left join stock_movements o on o.id = m.reverses_id
  group by m.item_slug, coalesce(o.type, m.type);

-- Read-back: expect 20 items, the new column, the new constraint and 3 views.
select (select count(*) from stock_items) as items,
       (select count(*) from information_schema.columns where table_name = 'stock_movements' and column_name = 'party') as party_column,
       (select count(*) from information_schema.views where table_name in ('stock_by_lot', 'stock_events', 'stock_totals')) as views;
