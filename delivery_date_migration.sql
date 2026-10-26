-- Delivery dates (27 Oct 2026). Run in the Supabase SQL editor BEFORE pushing the code that uses it. Safe to run twice.
-- Delhivery's promised delivery date for a shipped order, saved by the tracking sweep (utils/orderUpdates.js). The admin shows
-- it on the order and flags the order LATE once it is past this date and not delivered.
alter table orders add column if not exists expected_delivery_at timestamptz;

-- Read-back: expect 1.
select count(*) as expected_delivery_column from information_schema.columns where table_name = 'orders' and column_name = 'expected_delivery_at';
