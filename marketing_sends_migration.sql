-- Marketing sends (8 Nov 2026). Run in the Supabase SQL editor BEFORE pushing the code that uses it. Safe to run twice.
-- One row per broadcast message (utils/broadcast.js): stops the same template going to anyone twice, and keeps everyone
-- under 3 marketing messages in 30 days. Only the backend's service key can read it.
create table if not exists marketing_sends (
  id        bigserial primary key,
  phone     text not null,                               -- digits with country code, as in contacts.phone
  template  text not null,                               -- the approved WhatsApp template name
  status    text not null check (status in ('sent', 'failed')),
  error     text,
  sent_at   timestamptz not null default now()
);
create index if not exists marketing_sends_phone_idx on marketing_sends (phone, sent_at);
create index if not exists marketing_sends_template_idx on marketing_sends (template);
alter table marketing_sends enable row level security;
