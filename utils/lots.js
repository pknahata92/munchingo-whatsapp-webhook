'use strict';
// Lot codes, IST dates, cut-offs, eligibility and landed cost for batch receiving. Pure: no requires, no I/O.
// Dates are 'YYYY-MM-DD' strings; arithmetic is in UTC.

const LETTERS = { 'atta-original': 'O', 'atta-kesari': 'K', 'atta-ajwain': 'A', 'atta-lite-sugar': 'L' };
const SLUG_OF_LETTER = Object.fromEntries(Object.entries(LETTERS).map(([s, l]) => [l, s]));
const STICKER_SKU = { 'atta-original': 'original', 'atta-kesari': 'kesari', 'atta-ajwain': 'ajwain', 'atta-lite-sugar': 'lite' };

const DEFAULTS = {
  shelf_days: 90, ship_floor_days: 50, dispatch_days: 2, old_bake_days: 7,
  sticker_flags: '--cols 3 --col-gap 0.7 --left 4.0 --small-mrp --pitch 18 --head-shift -54 --test',
  lots_from: null,
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

module.exports = { LETTERS, SLUG_OF_LETTER, DEFAULTS, readSettings, todayIst, addDays, datesFor, cutoffs, lotCode, parseCode, nextSeq, eligible, landedCost, stickerCommand };
