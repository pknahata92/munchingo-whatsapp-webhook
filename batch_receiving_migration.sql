-- Batch receiving, Phase 1 (Nov 2026). Run in the Supabase SQL editor AFTER stock_event_sale_migration.sql and BEFORE (or with) the push
-- of the code that uses it. Additive and safe to run twice; today's code keeps working with it in place.
-- What it adds: deliveries (one row per Krazy Bakers delivery), lots (one row per flavour per bake date, with status and dates),
-- three new movement types, the settings for the date rules, a private photo bucket, and ONE function that saves a delivery, its
-- lots and its movements in a single step (all of it or none of it). Lots already in the ledger are filled in as released lots,
-- so the website never goes suddenly sold out.

-- 1. The ledger: which delivery a line came from, why a box was written off, and three new movement types (17 in all).
alter table stock_movements add column if not exists delivery_id text;   -- plain text on purpose: no foreign key, the ledger never blocks
alter table stock_movements add column if not exists reason text;        -- on DAMAGED: transit, supplier or repack
alter table stock_movements drop constraint if exists stock_movements_type_check;
alter table stock_movements add constraint stock_movements_type_check check (type in ('RECEIVE','DAMAGED','SALE','SALE_UNDO','USE','SAMPLE','GIFT','EXHIBITION','EXHIBITION_RETURN','OFFLINE_SALE','EVENT_SALE','RETURN','COUNT_FIX','REVERSAL','SUPPLIER_RETURN','EXPIRED','REPLACEMENT'));
create index if not exists stock_movements_lot_idx on stock_movements (lot_code);   -- lot pages read the ledger by lot code

-- 2. Deliveries. The id is made on the phone when the page opens, so sending the same form twice can never save twice.
create table if not exists stock_deliveries (
  id             text primary key,
  supplier       text not null default 'Krazy Bakers',
  bill_no        text not null,                          -- invoice or estimate number
  part           integer not null default 1,
  bilty          text,                                   -- bus LR number, optional
  arrived_on     date,
  cartons        integer,
  invoice_paise  bigint,
  gst_paise      bigint,                                 -- GST on the bill; null when the bill is an estimate with no GST
  billed_kg      numeric(10,3),
  freight        jsonb not null default '{}'::jsonb,     -- {bus_per_carton, delhi_per_carton, porter, other}
  photos         text[] not null default '{}',
  note           text,
  status         text not null default 'received' check (status in ('received','void')),
  saved_by_email text,
  saved_by_name  text,
  input          jsonb,                                  -- the form as sent, for prefill and resend
  result         jsonb,                                  -- what Save returned
  created_at     timestamptz not null default now()
);
-- A corrected (void) delivery frees its bill and part so the right one can be saved again.
drop index if exists stock_deliveries_bill_part_once;   -- rebuilt every run: an older non-partial version must not survive
create unique index if not exists stock_deliveries_bill_part_once on stock_deliveries (lower(supplier), lower(bill_no), part) where status <> 'void';

-- 3. Lots: one per flavour per bake date. A lot in the ledger with no row here counts as released (the legacy rule).
create table if not exists stock_lots (
  item_slug       text not null references stock_items(slug),
  lot_code        text not null,
  delivery_id     text,
  supplier_batch  text,                                  -- Krazy Bakers' own batch reference, optional
  bake_date       date,
  best_before     date,
  status          text not null default 'hold' check (status in ('hold','released','rejected','void')),
  released_at     timestamptz,
  released_by     text,
  check_weight_g  numeric(8,1),
  check_note      text,
  reject_reason   text,
  hold_reason     text,
  unit_cost_paise bigint,                                -- landed cost per good box
  aliases         text[] not null default '{}',          -- other codes that mean this lot (the sticker codes of batch 1 and 2)
  created_at      timestamptz not null default now(),
  primary key (item_slug, lot_code)
);
create index if not exists stock_lots_delivery_idx on stock_lots (delivery_id);
create index if not exists stock_lots_aliases_idx on stock_lots using gin (aliases);

alter table stock_deliveries enable row level security;   -- no public policies: only the backend's service key can read or write
alter table stock_lots enable row level security;

-- 4. Settings: the only place the date numbers live.
insert into stock_settings (key, value) values
  ('shelf_days', '90'),
  ('ship_floor_days', '50'),
  ('dispatch_days', '2'),
  ('old_bake_days', '7'),
  ('sticker_flags', '--cols 3 --col-gap 0.7 --left 4.0 --small-mrp --pitch 18 --head-shift -54 --test'),
  ('lots_from', now()::text),
  ('packaging_count_from', now()::text)   -- packaging counts restart here (8 Nov 2026): a packaging count is the sum of ledger rows on or after this time; nothing is deleted
on conflict (key) do nothing;

-- 4b. The trade case is 24 boxes now. Renames the old default name once; a name set by hand is left alone. Slug and case maths unchanged.
update stock_items set name = '24-box case carton' where slug = 'case-carton' and name = '20-box case carton';

-- 4c. A typed packaging count is recorded even when it is 0 or equals the number already there: the time it was last typed.
alter table stock_items add column if not exists counted_at timestamptz;   -- nullable on purpose; only packaging counts set it

-- 5. A private bucket for bill and carton photos (guarded and dynamic, so it also parses where there is no storage schema).
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    execute $q$ insert into storage.buckets (id, name, public) values ('stock-photos', 'stock-photos', false) on conflict (id) do nothing $q$;
  end if;
end $$;

-- 6. Save a delivery, its lots and its movements in one step. The caller puts the final `result` inside `d` first.
--    Same receipt id again: nothing is written and the first result comes back with "again": true.
--    Any other problem (a bad movement type, the same bill and part under a new id, a lot that already exists) raises and undoes everything.
create or replace function stock_save_delivery(d jsonb, lots jsonb, moves jsonb) returns jsonb
language plpgsql security invoker as $fn$
declare
  n integer;
  stored jsonb;
begin
  insert into stock_deliveries (id, supplier, bill_no, part, bilty, arrived_on, cartons, invoice_paise, gst_paise, billed_kg,
                                freight, photos, note, status, saved_by_email, saved_by_name, input, result)
  values (d->>'id', coalesce(d->>'supplier', 'Krazy Bakers'), d->>'bill_no', coalesce((d->>'part')::integer, 1), d->>'bilty',
          (d->>'arrived_on')::date, (d->>'cartons')::integer, (d->>'invoice_paise')::bigint, (d->>'gst_paise')::bigint, (d->>'billed_kg')::numeric,
          coalesce(d->'freight', '{}'::jsonb),
          coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(d->'photos') = 'array' then d->'photos' else '[]'::jsonb end)), '{}'::text[]),
          d->>'note', coalesce(d->>'status', 'received'), d->>'saved_by_email', d->>'saved_by_name', d->'input', d->'result')
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n = 0 then
    select result into stored from stock_deliveries where id = d->>'id';
    return coalesce(stored, '{}'::jsonb) || '{"again": true}'::jsonb;
  end if;

  insert into stock_lots (item_slug, lot_code, delivery_id, supplier_batch, bake_date, best_before, status, hold_reason, unit_cost_paise, aliases)
  select x.item_slug, x.lot_code, coalesce(x.delivery_id, d->>'id'), x.supplier_batch, x.bake_date, x.best_before,
         coalesce(x.status, 'hold'), x.hold_reason, x.unit_cost_paise, coalesce(x.aliases, '{}'::text[])
  from jsonb_to_recordset(coalesce(lots, '[]'::jsonb)) as x(item_slug text, lot_code text, delivery_id text, supplier_batch text, bake_date date,
                                                              best_before date, status text, hold_reason text, unit_cost_paise bigint, aliases text[]);

  insert into stock_movements (item_slug, qty, type, lot_code, best_before, ref, note, actor_email, actor_name, billed_kg, amount_paise, party, delivery_id, reason)
  select x.item_slug, x.qty, x.type, x.lot_code, x.best_before, x.ref, x.note, x.actor_email, x.actor_name, x.billed_kg, x.amount_paise, x.party,
         coalesce(x.delivery_id, d->>'id'), x.reason
  from jsonb_to_recordset(coalesce(moves, '[]'::jsonb)) as x(item_slug text, qty integer, type text, lot_code text, best_before date, ref text, note text,
                                                              actor_email text, actor_name text, billed_kg numeric, amount_paise bigint, party text,
                                                              delivery_id text, reason text);
  return d;
end
$fn$;

revoke all on function stock_save_delivery(jsonb, jsonb, jsonb) from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function stock_save_delivery(jsonb, jsonb, jsonb) from %I', r); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function stock_save_delivery(jsonb, jsonb, jsonb) to service_role;
  end if;
end $$;

-- 7. Backfill: one released lot row for every flavour + lot code already in the ledger (any quantity, even 0 or below), so nothing
--    that is on the shelf today changes. Bake date comes from the code (15OCT26 style, or MNGK-261105-01 style); best before is
--    the earliest one the ledger holds for that lot. The old shared codes get the sticker codes the printed boxes carry.
create or replace function stock_lot_bake_date(code text) returns date language plpgsql immutable as $f$
begin
  if code ~* '^\d{2}[A-Z]{3}\d{2}$' then return to_date(upper(code), 'DDMONYY'); end if;
  if code ~ '^MNG[OKAL]-\d{6}-\d{2}$' then return to_date(substr(code, 6, 6), 'YYMMDD'); end if;
  return null;
exception when others then
  return null;
end
$f$;

insert into stock_lots (item_slug, lot_code, status, bake_date, best_before, aliases)
select m.item_slug, m.lot_code, 'released', stock_lot_bake_date(m.lot_code), min(m.best_before),
       case
         when m.lot_code = '15OCT26' and l.letter is not null then array['MNG' || l.letter || '-261016-01']
         when m.lot_code = '27OCT26' and l.letter is not null then array['MNG' || l.letter || '-261027-01']
         else '{}'::text[]
       end
from stock_movements m
left join (values ('atta-original', 'O'), ('atta-kesari', 'K'), ('atta-ajwain', 'A'), ('atta-lite-sugar', 'L')) as l(slug, letter) on l.slug = m.item_slug
where m.lot_code is not null
  -- a code that only survives as another lot's alias (after Fix lot) is not a lot of its own
  and not exists (select 1 from stock_lots s where s.item_slug = m.item_slug and m.lot_code = any(s.aliases))
group by m.item_slug, m.lot_code, l.letter
on conflict (item_slug, lot_code) do nothing;

drop function if exists stock_lot_bake_date(text);

-- Read-back: expect 19 deliveries columns (incl. gst_paise), 16 lots columns, the type check listing 17 types, 7 settings, and the
-- number of lots filled in from the ledger (lots with no delivery).
select (select count(*) from information_schema.columns where table_name = 'stock_deliveries') as deliveries_columns,
       (select count(*) from information_schema.columns where table_name = 'stock_lots') as lots_columns,
       (select pg_get_constraintdef(oid) from pg_constraint where conname = 'stock_movements_type_check') as type_check,
       (select count(*) from stock_settings where key in ('shelf_days', 'ship_floor_days', 'dispatch_days', 'old_bake_days', 'sticker_flags', 'lots_from', 'packaging_count_from')) as settings,
       (select count(*) from stock_lots where delivery_id is null) as backfilled_lots;
