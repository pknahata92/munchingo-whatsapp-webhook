'use strict';
// The marketing send log is read whole (A8 fix wave, 16 Nov 2026). PostgREST returns at most 1000 rows per request, in no fixed
// order unless asked, so an unpaged read silently drops rows once the table passes 1000 and the cap / already_sent checks fail
// open. listMarketingSends pages like listPaidOrderAddresses (stable order, range loop until a short page); with
// { sinceIso, template } it reads every row of that template (already_sent has no time limit) plus every row since sinceIso
// (the cap and the cool-off count every template). Then the callers: broadcast.js and reorders.js see rows past the first 1000.
//   node scripts/marketing-sends-paging-test.js
const path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// ── a fake PostgREST: max 1000 rows per request; without .order() the rows come back in a different order every time ──
const tables = { marketing_sends: [], contacts: [] };
const requests = [];
let shuffleSeed = 1;
function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { shuffleSeed = (shuffleSeed * 48271) % 2147483647; const j = shuffleSeed % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const unquote = (v) => (/^".*"$/.test(v) ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v);
const cmp = (col, a, b) => (/_at$/.test(col) ? (Date.parse(a) || 0) - (Date.parse(b) || 0) : a < b ? -1 : a > b ? 1 : 0);
const test1 = (row, col, op, v) => (op === 'eq' ? String(row[col]) === String(v) : op === 'gte' ? row[col] != null && cmp(col, row[col], v) >= 0 : (() => { throw new Error('fake: no op ' + op); })());
// "a.eq.x,b.gte.\"y\"" -> [[a, eq, x], [b, gte, y]] (commas inside double quotes are kept)
function parseOr(expr) {
  const parts = []; let cur = '', q = false;
  for (const ch of expr) { if (ch === '"') q = !q; if (ch === ',' && !q) { parts.push(cur); cur = ''; } else cur += ch; }
  parts.push(cur);
  return parts.map((p) => { const m = p.match(/^([a-z_]+)\.(eq|gte)\.(.*)$/); if (!m) throw new Error('fake: bad or() part ' + p); return [m[1], m[2], unquote(m[3])]; });
}
function query(name) {
  const st = { filters: [], orders: [], range: null, cols: null };
  const q = {
    select(cols) { st.cols = cols; return q; },
    eq(col, v) { st.filters.push((r) => test1(r, col, 'eq', v)); return q; },
    gte(col, v) { st.filters.push((r) => test1(r, col, 'gte', v)); return q; },
    or(expr) { const ps = parseOr(expr); st.filters.push((r) => ps.some(([c, op, v]) => test1(r, c, op, v))); return q; },
    order(col, o = {}) { st.orders.push([col, o.ascending !== false]); return q; },
    range(from, to) { st.range = [from, to]; return q; },
    then(res, rej) {
      requests.push({ table: name, ...st });
      let rows = tables[name].filter((r) => st.filters.every((f) => f(r)));
      if (st.orders.length) rows = rows.slice().sort((a, b) => { for (const [c, asc] of st.orders) { const d = cmp(c, a[c], b[c]); if (d) return asc ? d : -d; } return 0; });
      else rows = shuffled(rows);
      rows = st.range ? rows.slice(st.range[0], st.range[1] + 1) : rows;
      rows = rows.slice(0, 1000).map((r) => { const o = {}; for (const c of String(st.cols).split(',').map((s) => s.trim())) o[c] = r[c]; return o; });
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    },
  };
  return q;
}
const sb = require.resolve('@supabase/supabase-js', { paths: [path.join(__dirname, '..')] });
require.cache[sb] = { id: sb, filename: sb, loaded: true, exports: { createClient: () => ({ from: query }) } };
const db = require('../utils/database');

const DAY = 86_400_000, NOW = Date.parse('2026-11-16T06:30:00Z');   // 12:00 IST
const iso = (ms) => new Date(ms).toISOString();
const T = 'munchingo_diwali_2026';
let id = 0;
const row = (phone, template, ms, extra = {}) => ({ id: ++id, phone, template, status: 'sent', error: null, sent_at: iso(ms), campaign: null, wa_message_id: 'wamid.' + id, ...extra });
const ids = (rows) => rows.map((r) => r.wa_message_id).sort().join();

(async () => {
  // 2,500 rows: 2,000 old sends to other people (60 days ago, other templates), then the rows that matter, past row 1000
  for (let i = 0; i < 2000; i++) tables.marketing_sends.push(row('9190000' + String(10000 + (i % 400)), 'munchingo_old_' + (i % 3), NOW - 60 * DAY + i * 1000));
  const ASHA = '919810000001', RAVI = '919810000002', MEENA = '919810000003';
  tables.marketing_sends.push(row(ASHA, 'munchingo_reorder_try', NOW - 20 * DAY, { campaign: 'j6:MNG-A' }));   // Asha: 3 in 30 days -> over_cap
  tables.marketing_sends.push(row(ASHA, 'munchingo_fresh_batch', NOW - 10 * DAY, { campaign: 'batch_261106' }));
  tables.marketing_sends.push(row(ASHA, 'munchingo_sets_newyear', NOW - 2 * DAY));
  tables.marketing_sends.push(row(RAVI, T, NOW - 45 * DAY));   // Ravi: this template, 45 days ago -> already_sent (no time limit)
  for (let i = 0; i < 497; i++) tables.marketing_sends.push(row('9191000' + String(10000 + i), 'munchingo_other_' + (i % 2), NOW - 5 * DAY + i * 1000));
  const ALL = tables.marketing_sends;
  ok(ALL.length === 2501, 'the fake table has 2,501 rows');

  // ── 1. the whole table, paged in a stable order ──
  requests.length = 0;
  let got = await db.listMarketingSends();
  ok(got.length === ALL.length, `listMarketingSends() reads every row past the 1000-row cap (got ${got.length} of ${ALL.length})`);
  ok(ids(got) === ids(ALL), 'each row exactly once: none missing, none twice');
  ok(requests.length >= 3 && requests.every((r) => r.range && r.orders.length > 0), `paged with .range() and a stable .order() on every request (${requests.length} requests)`);
  ok(requests.every((r) => r.orders.some(([c]) => c === 'id')), 'ordered by the primary key id, so equal sent_at values cannot shuffle between pages');
  ok(Object.keys(got[0]).sort().join() === 'campaign,error,phone,sent_at,status,template,wa_message_id', 'the same columns as before (got ' + Object.keys(got[0]).sort().join() + ')');

  // exactly 1000 rows: one more (empty) page is read, nothing lost
  const saved = tables.marketing_sends; tables.marketing_sends = saved.slice(0, 1000);
  got = await db.listMarketingSends();
  ok(got.length === 1000, 'a table of exactly 1000 rows is read whole');
  tables.marketing_sends = saved;

  // ── 2. { sinceIso, template }: every row of the template, any time, plus every row of any template since sinceIso ──
  const since = iso(NOW - 30 * DAY);
  const want = ALL.filter((r) => r.template === T || Date.parse(r.sent_at) >= Date.parse(since));
  requests.length = 0;
  got = await db.listMarketingSends({ sinceIso: since, template: T });
  ok(got.length === want.length && ids(got) === ids(want), `{ sinceIso, template } returns the template's whole history plus the last 30 days of every template (got ${got.length}, want ${want.length})`);
  ok(got.some((r) => r.phone === RAVI && r.template === T), "it keeps Ravi's 45-day-old send of this template (already_sent has no time limit)");
  ok(got.filter((r) => r.phone === ASHA).length === 3, "it keeps all three of Asha's sends of other templates (the cap counts every template)");
  ok(got.length < ALL.length, 'and leaves out the old rows of other templates');
  got = await db.listMarketingSends({ sinceIso: since });
  ok(ids(got) === ids(ALL.filter((r) => Date.parse(r.sent_at) >= Date.parse(since))), '{ sinceIso } alone: every row since then');
  got = await db.listMarketingSends({ template: T });
  ok(ids(got) === ids(ALL.filter((r) => r.template === T)), '{ template } alone: every row of that template');

  // ── 3. the callers ──
  // broadcast.js, dry run: Asha's three sends and Ravi's earlier send sit past row 2000 of the table
  tables.contacts = [ASHA, RAVI, MEENA].map((p, i) => ({ phone: p, name: ['Asha', 'Ravi', 'Meena'][i], first_source: 'join:2026-10-25', last_source: 'join:2026-10-25', consent_marketing: true, consent_reminder: false }));
  const b = require('../utils/broadcast');
  b.setDeps({ db: { ...db, listPaidOrderAddresses: async () => [] }, wa: {}, now: () => NOW, wait: async () => {}, ownerPhone: () => '' });
  const r = await b.run({ template: T, mode: 'dry' });
  ok(r.ok && r.over_cap === 1 && r.already_sent === 1 && r.to_send === 1, 'broadcast dry run: Asha over the cap, Ravi already sent, only Meena to send (got ' + JSON.stringify(r) + ')');

  // reorders.js: loadInput hands planReorders every row
  const ro = require('../utils/reorders');
  ro.setDeps({ db: { ...db, getPaidOrdersUpdatedSince: async () => [], listActiveSubscriptionPhones: async () => [], listStallOrdersWithPhone: async () => [], listOrderEventsByName: async () => [] }, wa: {}, now: () => NOW, inStock: async () => new Set(), lang: async () => 'en' });
  const input = await ro.loadInput(NOW);
  ok(input.sends && input.sends.length === ALL.length && ids(input.sends) === ids(ALL), `reorders.loadInput gets every send (got ${input.sends && input.sends.length})`);

  console.log(`marketing-sends-paging-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
