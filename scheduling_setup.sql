-- Reliable schedules for Munchingo, run ONCE in the Supabase SQL editor (no secret needed).
-- Why: GitHub's free scheduler runs the 8:00 AM job 6+ hours late (observed 14:00-16:40 IST daily).
-- Supabase's pg_cron runs to the minute. 02:30 UTC = 8:00 AM IST (pg_cron uses UTC).
-- The summary endpoint accepts this bare call only between 7:30 AM and noon IST and sends at most once a day.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 8:00 AM IST daily: email summary of the previous day.
select cron.schedule('munchingo-daily-summary', '30 2 * * *', $$
  select net.http_get(
    url := 'https://munchingo-whatsapp-webhook.onrender.com/internal/daily-digest',
    timeout_milliseconds := 120000
  );
$$);

-- Every 5 minutes: keep the free Render instance awake so payment webhooks answer fast.
select cron.schedule('munchingo-keep-warm', '*/5 * * * *', $$
  select net.http_get(url := 'https://munchingo-whatsapp-webhook.onrender.com/', timeout_milliseconds := 60000);
$$);

-- To stop either job:  select cron.unschedule('munchingo-daily-summary');
-- To check they ran:   select jobid, status, start_time from cron.job_run_details order by start_time desc limit 10;

-- J6 reorder reminder (growth journey, 16 Nov 2026). Prashant (the owner) runs it in Supabase (SQL editor) himself, after the
-- growth-journey push is live and growth_journey_migration.sql has been run. Remove the leading "-- " from the select line to run it.
-- 10:30 UTC = 16:00 IST. The endpoint accepts this bare call only between 15:30 and 18:00 IST, runs at most once a day, and sends
-- nothing until JOURNEY_J6_ENABLED=1 is set on Render (after Meta approves munchingo_reorder_try and munchingo_reorder_same).
-- select cron.schedule('munchingo-reorders', '30 10 * * *', $$ select net.http_get(url := 'https://munchingo-whatsapp-webhook.onrender.com/internal/reorders', timeout_milliseconds := 120000); $$);
-- To stop it:  select cron.unschedule('munchingo-reorders');
