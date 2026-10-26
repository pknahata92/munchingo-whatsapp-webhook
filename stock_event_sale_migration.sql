-- Sales at an exhibition or event (26 Oct 2026). Run in the Supabase SQL editor AFTER stock_offline_migration.sql and BEFORE
-- pushing the code that uses it. Safe to run twice. Adds one movement type, EVENT_SALE: boxes sold to walk-in buyers at a
-- fair or stall (no invoice per buyer). `ref` holds the event name. Nothing else changes.
alter table stock_movements drop constraint if exists stock_movements_type_check;
alter table stock_movements add constraint stock_movements_type_check check (type in ('RECEIVE','DAMAGED','SALE','SALE_UNDO','USE','SAMPLE','GIFT','EXHIBITION','EXHIBITION_RETURN','OFFLINE_SALE','EVENT_SALE','RETURN','COUNT_FIX','REVERSAL'));

-- Read-back: expect the constraint to list EVENT_SALE.
select pg_get_constraintdef(oid) as type_check from pg_constraint where conname = 'stock_movements_type_check';
