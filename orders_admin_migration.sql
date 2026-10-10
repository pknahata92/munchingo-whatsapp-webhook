-- Admin page support — run ONCE in the Supabase SQL editor.
-- Adds shipping + note fields to orders. Order STATUS is deliberately left alone (shipped = shipped_at is set),
-- so the daily packing list and refunds keep working exactly as before.
alter table orders add column if not exists shipped_at  timestamptz;
alter table orders add column if not exists carrier     text;
alter table orders add column if not exists awb         text;
alter table orders add column if not exists admin_note  text;
