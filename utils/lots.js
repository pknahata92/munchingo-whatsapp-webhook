'use strict';
// Lot codes, IST dates, cut-offs, eligibility and landed cost for batch receiving. Pure: no requires, no I/O.
// Dates are 'YYYY-MM-DD' strings; arithmetic is in UTC.

const LETTERS = { 'atta-original': 'O', 'atta-kesari': 'K', 'atta-ajwain': 'A', 'atta-lite-sugar': 'L' };
const SLUG_OF_LETTER = Object.fromEntries(Object.entries(LETTERS).map(([s, l]) => [l, s]));
const STICKER_SKU = { 'atta-original': 'original', 'atta-kesari': 'kesari', 'atta-ajwain': 'ajwain', 'atta-lite-sugar': 'lite' };

const DEFAULTS = {
  shelf_days: 90, ship_floor_days: 50, dispatch_days: 2, old_bake_days: 7,
  sticker_flags: '--cols 3 --col-gap 0.7 --left 4.0 --small-mrp --pitch 17.84375 --head-shift 2 --test',
  lots_from: null,
  packaging_count_from: null,   // packaging counts restart here (null = no reset)
};

function readSettings(raw) {
  const r = raw || {};
  const out = { ...DEFAULTS };
  for (const k of ['shelf_days', 'ship_floor_days', 'dispatch_days', 'old_bake_days']) {
    const v = r[k];
    if (v != null && /^\s*\d+\s*$/.test(String(v))) out[k] = parseInt(String(v), 10);
  }
  if (r.sticker_flags != null) out.sticker_flags = String(r.sticker_flags);
  out.lots_from = r.lots_from != null ? String(r.lots_from) : null;
  out.packaging_count_from = r.packaging_count_from != null ? String(r.packaging_count_from) : null;
  return out;
}

function todayIst(nowMs) { return new Date(nowMs + 330 * 60000).toISOString().slice(0, 10); }

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function cutoffs(bestBefore, s) {
  if (!bestBefore) return null;
  const lastShip = addDays(bestBefore, -s.ship_floor_days);
  return { lastShip, websiteStop: addDays(lastShip, -s.dispatch_days) };
}

function datesFor(bakeDate, s) {
  const bestBefore = addDays(bakeDate, s.shelf_days);
  return { bestBefore, ...cutoffs(bestBefore, s) };
}

function lotCode(slug, bakeDate, seq) {
  const letter = LETTERS[slug];
  if (!letter) throw new Error('Unknown flavour: ' + slug);
  if (!Number.isInteger(seq) || seq < 1 || seq > 99) throw new Error('Lot number must be 1 to 99');
  return 'MNG' + letter + '-' + bakeDate.slice(2, 4) + bakeDate.slice(5, 7) + bakeDate.slice(8, 10) + '-' + String(seq).padStart(2, '0');
}

function parseCode(code) {
  const m = /^MNG([OKAL])-(\d{6})-(\d{2})$/.exec(String(code == null ? '' : code));
  if (!m) return null;
  const yy = m[2].slice(0, 2), mm = m[2].slice(2, 4), dd = m[2].slice(4, 6);
  const bakeDate = '20' + yy + '-' + mm + '-' + dd;
  if (addDays(bakeDate, 0) !== bakeDate) return null; // not a real calendar date
  return { slug: SLUG_OF_LETTER[m[1]], bakeDate, seq: parseInt(m[3], 10) };
}

function nextSeq(existingCodes, slug, bakeDate) {
  let max = 0;
  for (const c of existingCodes || []) {
    const p = parseCode(c);
    if (p && p.slug === slug && p.bakeDate === bakeDate && p.seq > max) max = p.seq;
  }
  return max + 1;
}

// lot: { status|null, best_before|null }. Released and legacy (null) lots count; hold, rejected and void never do.
function eligible(lot, purpose, today, s) {
  const st = lot.status == null ? null : lot.status;
  if (st !== null && st !== 'released') return false;
  const c = cutoffs(lot.best_before, s);
  if (!c) return true;
  if (purpose === 'web') return today < c.websiteStop;
  if (purpose === 'pack') return today <= c.lastShip;
  return today <= lot.best_before;
}

// Rates are as typed (pre-GST). Freight is shared by invoice boxes. Rounded to paise once per lot.
function landedCost({ cartons, freight, lots }) {
  const f = freight || {};
  const freightPaise = ((f.bus_per_carton || 0) + (f.delhi_per_carton || 0)) * (cartons || 0) * 100 + ((f.porter || 0) + (f.other || 0)) * 100;
  const totalBoxes = lots.reduce((a, l) => a + (l.invoiceBoxes || 0), 0);
  const out = {};
  for (const l of lots) {
    const share = totalBoxes > 0 ? freightPaise * (l.invoiceBoxes || 0) / totalBoxes : 0;
    const landedPaise = Math.round((l.invoiceBoxes || 0) * (l.rateRupees || 0) * 100 + share);
    out[l.key] = { landedPaise, perGoodPaise: l.good > 0 ? Math.round(landedPaise / l.good) : null };
  }
  return out;
}

function stickerCommand(code, good, flags) {
  const p = parseCode(code);
  const sku = p ? STICKER_SKU[p.slug] : null;
  if (!sku) throw new Error('Cannot make a sticker command for ' + code);
  const f = String(flags == null ? '' : flags).trim();
  return 'python3 make_stamp_labels.py --lot ' + code + ' --qty ' + sku + '=' + good + (f ? ' ' + f : '');
}

// ---- Which lot a code means (final review C1, C2) ----
// 'slug|code' -> the stock_lots row that code belongs to: every row's own code, and its aliases, except an alias that another row of the
// same flavour has as its own code (that row owns it). When two rows list the same alias, the one that is not released wins, so a hold
// is never lost.
function lotIndex(rows) {
  const own = new Map(), alias = new Map();
  for (const l of rows || []) own.set(`${l.item_slug}|${l.lot_code}`, l);
  for (const l of rows || []) {
    for (const a of l.aliases || []) {
      const k = `${l.item_slug}|${a}`;
      if (own.has(k)) continue;
      const cur = alias.get(k);
      if (!cur || (cur.status === 'released' && l.status !== 'released')) alias.set(k, l);
    }
  }
  return new Map([...alias, ...own]);
}
// A lot's codes: its own code first, then the aliases that are its (see lotIndex).
const codesOfLot = (index, l) => [l.lot_code, ...(l.aliases || []).filter((a) => index.get(`${l.item_slug}|${a}`) === l)];

// The lots a typed code can mean, at most ONE per flavour, sorted by flavour: within a flavour (a) a lot whose own code is exactly the
// code, else (b) one whose own code matches ignoring case, else (c) one that has it as an alias (any case). A ledger code with no row
// (legacy) counts as an own code. How exactly the code matches comes first (as typed, then its upper-case form, then any case), then own
// code before alias: so after Fix lot 15OCT26 -> MNGL-261016-01, "15OCT26" (now an alias) still reaches that lot, not an empty lot
// spelt 15Oct26. Last, the most boxes on hand. [{ slug, code, row (null for legacy), how: 'exact' | 'case' | 'alias' }]
function resolveCode(rows, ledger, code, slug) {
  const t = String(code == null ? '' : code).trim(), c = t.toUpperCase();
  if (!t) return [];
  const index = lotIndex(rows);
  const onHand = new Map();
  for (const r of ledger || []) if (r.lot_code != null) { const k = `${r.item_slug}|${r.lot_code}`; onHand.set(k, (onHand.get(k) || 0) + (Number(r.qty) || 0)); }
  const score = (e) => [e.typed === t ? 0 : e.typed === c ? 1 : 2, e.how === 'alias' ? 1 : 0, -(onHand.get(`${e.slug}|${e.typed}`) || 0), e.code];
  const before = (a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
  const best = new Map();
  const offer = (e) => { const cur = best.get(e.slug); if (!cur || before(e, cur)) best.set(e.slug, e); };
  for (const l of rows || []) {
    if (slug && l.item_slug !== slug) continue;
    const s = l.item_slug;
    if (l.lot_code === t) offer({ slug: s, code: l.lot_code, row: l, how: 'exact', typed: l.lot_code });
    else if (String(l.lot_code).toUpperCase() === c) offer({ slug: s, code: l.lot_code, row: l, how: 'case', typed: l.lot_code });
    for (const a of codesOfLot(index, l).slice(1)) if (String(a).toUpperCase() === c) offer({ slug: s, code: l.lot_code, row: l, how: 'alias', typed: a });
  }
  const seen = new Set();
  for (const r of ledger || []) {
    if (r.lot_code == null || (slug && r.item_slug !== slug)) continue;
    const k = `${r.item_slug}|${r.lot_code}`;
    if (seen.has(k) || index.has(k)) continue;   // a code a row owns or has as an alias belongs to that row
    seen.add(k);
    if (r.lot_code === t) offer({ slug: r.item_slug, code: r.lot_code, row: null, how: 'exact', typed: r.lot_code });
    else if (String(r.lot_code).toUpperCase() === c) offer({ slug: r.item_slug, code: r.lot_code, row: null, how: 'case', typed: r.lot_code });
  }
  return [...best.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)).map(({ slug: s, code: cd, row, how }) => ({ slug: s, code: cd, row, how }));
}

// Final review I2: a lot the owner put on hold (Hold this lot needs a reason, and only a released lot can be held), as opposed to a new
// delivery waiting for its first Release. A backfilled lot was released with no released_at, so the reason is what tells them apart.
const ownerHold = (l) => !!l && l.status === 'hold' && (l.released_at != null || (l.hold_reason != null && l.hold_reason !== ''));

module.exports = { LETTERS, SLUG_OF_LETTER, DEFAULTS, readSettings, todayIst, addDays, datesFor, cutoffs, lotCode, parseCode, nextSeq, eligible, landedCost, stickerCommand, lotIndex, codesOfLot, resolveCode, ownerHold };
