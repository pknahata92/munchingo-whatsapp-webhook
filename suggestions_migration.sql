-- Suggestions (28 Oct 2026). Run in the Supabase SQL editor BEFORE pushing the code that uses it. Safe to run twice.
-- What customers suggest on WhatsApp (and the older feedback form's answers), and which numbers the bot is waiting on.
create table if not exists suggestions (
  id          bigserial primary key,
  phone       text not null,
  name        text,
  kind        text not null default 'suggestion' check (kind in ('suggestion','feedback')),
  text        text,
  rating      text,                                   -- feedback form only
  order_id    text,                                   -- their latest order, if any
  status      text not null default 'new' check (status in ('new','planned','done','not_for_us')),
  status_by   text,
  status_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists suggestions_created_idx on suggestions (created_at desc);
alter table suggestions enable row level security;    -- no public policies: only the backend's service key can read it

-- The bot asked this number for a suggestion; its next message within 30 minutes is taken as the answer.
create table if not exists suggestion_waits (
  phone     text primary key,
  asked_at  timestamptz not null
);
alter table suggestion_waits enable row level security;

-- Read-back: expect 2.
select count(*) as tables from information_schema.tables where table_name in ('suggestions', 'suggestion_waits');
