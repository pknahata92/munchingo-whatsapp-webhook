-- Munchingo GST invoices — run this once in the Supabase SQL editor before the
-- invoice code (utils/invoice.js, server.js payment webhook) goes live.
-- Same RLS posture as `orders`: service-role only, no public policies.
-- If this has NOT been run, the payment webhook logs "[INVOICE] skipped" and
-- carries on exactly as before (confirmation WhatsApp + email still go out).

-- One counter row per Indian financial year (Apr–Mar), e.g. '26-27'.
create table if not exists invoice_counters (
  fy        text primary key,
  last_seq  integer not null default 0
);

-- Atomic "give me the next number" — safe under concurrent payment webhooks.
create or replace function next_invoice_seq(p_fy text) returns integer
language plpgsql as $$
declare s integer;
begin
  insert into invoice_counters (fy, last_seq) values (p_fy, 1)
  on conflict (fy) do update set last_seq = invoice_counters.last_seq + 1
  returning last_seq into s;
  return s;
end $$;

create table if not exists invoices (
  order_id         text primary key,            -- one invoice per order
  invoice_no       text not null unique,        -- e.g. MUN/26-27/0001
  fy               text not null,
  seq              integer not null,
  issued_at        timestamptz not null default now(),
  buyer_state      text,
  supply_type      text not null check (supply_type in ('intra', 'inter')),
  total_paise      integer not null,
  taxable_paise    integer not null,
  cgst_paise       integer not null default 0,
  sgst_paise       integer not null default 0,
  igst_paise       integer not null default 0,
  data             jsonb not null,              -- full computed invoice (lines, buyer, words)
  email_sent_at    timestamptz,
  wa_sent_at       timestamptz,
  zoho_invoice_id  text,
  zoho_synced_at   timestamptz,
  unique (fy, seq)
);

alter table invoice_counters enable row level security;
alter table invoices         enable row level security;
