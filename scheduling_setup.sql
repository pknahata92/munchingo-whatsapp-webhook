-- Reliable schedules for Munchingo, run ONCE in the Supabase SQL editor.
-- Why: GitHub's free scheduler runs the 8:00 AM job 6+ hours late (observed 14:00-16:40 IST daily),
-- and the same problem makes the "keep warm" ping unreliable. Supabase's pg_cron runs to the minute.
-- Before running: replace PASTE_DIGEST_SECRET with the DIGEST_SECRET value from Render.
-- 02:30 UTC = 8:00 AM IST (pg_cron uses UTC).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 8:00 AM IST daily: summary email of the previous day.
select cron.schedule('munchingo-daily-summary', '30 2 * * *', $$
  select net.http_get(
    url := 'https://munchingo-whatsapp-webhook.onrender.com/internal/daily-digest?secret=PASTE_DIGEST_SECRET',
    timeout_milliseconds := 120000
  );
$$);

-- Every 5 minutes: keep the free Render instance awake so payment webhooks answer fast.
select cron.schedule('munchingo-keep-warm', '*/5 * * * *', $$
  select net.http_get(url := 'https://munchingo-whatsapp-webhook.onrender.com/', timeout_milliseconds := 60000);
$$);

-- To stop either job:  select cron.unschedule('munchingo-daily-summary');
-- To check they ran:   select jobid, status, start_time from cron.job_run_details order by start_time desc limit 10;
