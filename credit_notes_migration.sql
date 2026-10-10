-- Munchingo GST credit notes (refund flow) — run ONCE in the Supabase SQL editor.
-- Until this has run, refunds still notify the customer and cancel full-refund orders exactly as before;
-- credit notes are simply skipped (logged as "[REFUND] credit note skipped").
-- Numbering re-uses next_invoice_seq() from invoices_migration.sql with its own series key (CN-26-27).

create table if not exists credit_notes (
  credit_note_no   text primary key,            -- e.g. CN/26-27/0001
  refund_id        text not null unique,        -- Razorpay refund id: one credit note per refund (idempotent)
  order_id         text not null,
  invoice_no       text not null,
  fy               text not null,
  seq              integer not null,
  issued_at        timestamptz not null default now(),
  reason_code      text,
  reason_note      text,
  amount_paise     integer not null,
  taxable_paise    integer not null,
  cgst_paise       integer not null default 0,
  sgst_paise       integer not null default 0,
  igst_paise       integer not null default 0,
  is_full          boolean not null default false,
  data             jsonb not null,
  zoho_credit_note_id text,
  zoho_synced_at   timestamptz,
  unique (fy, seq)
);
create index if not exists credit_notes_order_idx on credit_notes (order_id);
alter table credit_notes enable row level security;
