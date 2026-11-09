'use strict';

/**
 * Stock ledger. Nobody types a total: every receipt, sale, damage and count is a row in stock_movements and stock on hand is the sum.
 * Rows are never edited or deleted; a mistake is cancelled with a REVERSAL row. See stock_ledger_migration.sql.
 *
 * All logic lives in makeInventory(store) so it can be tested against an in-memory store (scripts/inventory-test.js);
 * supabaseStore() is the real storage. Sales are deducted when an order is marked Packed (oldest best-before first) and never
 * block packing: any failure here is logged and the order still moves on.
 */
const { flavoursOf } = require('./orderText');
const lotRules = require('./lots');

const HELD_NOTE = 'on hold or past best before';
class StockError extends Error { constructor(msg, status = 400, extra = {}) { super(msg); this.status = status; this.extra = extra; } }

const TYPES_OUT = { USE: 'Used', DAMAGED: 'Damaged or not okay', SAMPLE: 'Sample or tasting', GIFT: 'Given away', EXHIBITION: 'Taken to an exhibition or event', EVENT_SALE: 'Sold at an exhibition or event', OFFLINE_SALE: 'Sold offline (bulk order or hamper)' };
const NEEDS_WHO = { GIFT: 'Enter who it is going to.', EXHIBITION: 'Enter the event name.', EVENT_SALE: 'Enter the event name.', OFFLINE_SALE: 'Enter who bought it.' };
const MAX_QTY = 100000;
const DUP_WINDOW_MS = 15 * 60_000;
const DAMAGED_ON_RECEIPT = 'Damaged or not okay on receipt';
const DAMAGE_REASONS = new Set(['transit', 'supplier', 'repack']);
const HISTORY_TYPES = new Set(['RECEIVE', 'DAMAGED', 'SALE', 'SALE_UNDO', 'USE', 'SAMPLE', 'GIFT', 'EXHIBITION', 'EXHIBITION_RETURN', 'OFFLINE_SALE', 'EVENT_SALE', 'RETURN', 'COUNT_FIX', 'REVERSAL', 'SUPPLIER_RETURN', 'EXPIRED']);
const REVERSE_FREE_MS = 24 * 3_600_000;       // anyone can reverse their own slip within a day; later needs the owner
// A stock_settings time (the database writes now()::text, e.g. '2026-11-08 15:10:00+00') as milliseconds; null when it is missing or unreadable.
const tsMs = (v) => { if (v == null || v === '') return null; const n = Date.parse(v); return Number.isNaN(n) ? null : n; };
const slugOfToken = (token) => `atta-${token}`;
const int = (v) => (typeof v === 'number' ? v : Number(String(v == null ? '' : v).trim()));
const cleanText = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const validLot = (v) => /^[A-Za-z0-9][A-Za-z0-9 ._\/-]{0,39}$/.test(String(v || ''));
const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));

// Take `qty` from lots, oldest best-before first (no date last). Returns the pieces and whatever the lots could not cover.
function allocate(lots, qty) {
  const sorted = lots.filter((l) => l.qty > 0).slice().sort((a, b) => {
    if (!a.best_before && !b.best_before) return 0; if (!a.best_before) return 1; if (!b.best_before) return -1;
    return a.best_before < b.best_before ? -1 : a.best_before > b.best_before ? 1 : 0;
  });
  let left = qty; const pieces = [];
  for (const l of sorted) { if (left <= 0) break; const take = Math.min(left, l.qty); pieces.push({ lot_code: l.lot_code, best_before: l.best_before, qty: take }); left -= take; }
  return { pieces, short: left };
}

// What the stock_lots table and the settings say, read once per question. `meta` is keyed 'slug|code' (codes are case-sensitive) and covers
// every code of a lot, its aliases too (final review C2), so boxes booked under an old or sticker code are held, released and dated with
// the lot. An alias another row of the flavour owns as its own code belongs to that row (lots.lotIndex).
// Final review I1: the code pushed before batch_receiving_migration.sql is run. A missing lot table (or settings) reads as no lot rows
// and the default settings, so every ledger lot is legacy (released) exactly as before lots, and the website keeps its stock limits.
// Said once in the log. Any other failure still throws (utils/stock.js then keeps the last known answer).
const MIGRATION_MISSING = /Run batch_receiving_migration\.sql/;
let warnedMissing = false;
const orMissing = (p, empty) => p.catch((e) => {
  if (!MIGRATION_MISSING.test(String(e && e.message))) throw e;
  if (!warnedMissing) { warnedMissing = true; console.error('[STOCK] batch receiving tables missing: run batch_receiving_migration.sql'); }
  return empty;
});
async function lotContext(store, nowMs) {
  const [rows, raw] = await Promise.all([orMissing(Promise.resolve().then(() => store.lots()), []), orMissing(Promise.resolve().then(() => store.settingsAll()), {})]);
  const meta = {};
  for (const [k, l] of lotRules.lotIndex(rows || [])) meta[k] = { status: l.status == null ? null : l.status, best_before: l.best_before || null, lot: l.lot_code, ownerHold: lotRules.ownerHold(l) };
  return { meta, today: lotRules.todayIst(nowMs), s: lotRules.readSettings(raw) };
}
// A ledger row's lot: the stock_lots row decides the status (and the best before when it has one); a row with no lot row, or no lot code, is legacy.
function lotInfo(ctx, r) {
  const m = r.lot_code != null ? ctx.meta[`${r.item_slug}|${r.lot_code}`] : null;
  return m ? { status: m.status, best_before: m.best_before || r.best_before || null, lot: m.lot, ownerHold: m.ownerHold } : { status: null, best_before: r.best_before || null };
}
const eligibleRow = (ctx, r, purpose) => lotRules.eligible(lotInfo(ctx, r), purpose, ctx.today, ctx.s);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (iso) => `${parseInt(iso.slice(8, 10), 10)} ${MONTHS[parseInt(iso.slice(5, 7), 10) - 1]}`;
// One line per lot for packing: stock_by_lot splits a lot by best before, but a pack writes one sale per lot (the database allows one
// per pack, flavour and lot), so a lot is summed whole, with its earliest best before. Rows with no lot are left out: packing never sends
// a box without a lot (spec 1), so stock with no lot (a count up, say) is not packable.
function packLots(rows) {
  const byCode = new Map();
  for (const r of rows) {
    if (r.lot_code == null) continue;
    const e = byCode.get(r.lot_code) || { item_slug: r.item_slug, lot_code: r.lot_code, best_before: null, qty: 0 };
    e.qty += r.qty; if (r.best_before && (!e.best_before || r.best_before < e.best_before)) e.best_before = r.best_before;
    byCode.set(r.lot_code, e);
  }
  return [...byCode.values()];
}
// Why a flavour cannot be packed (spec 6.6), in plain words: the oldest held lot that has boxes; else the oldest released or legacy lot
// that is past its last ship date but still before best before (it can still go to fairs); else the stock has to come in.
function packHint(ctx, rows) {
  const lots = packLots(rows).filter((l) => l.qty > 0).map((l) => ({ code: l.lot_code, ...lotInfo(ctx, l) }))
    .sort((a, b) => String(a.best_before || '9').localeCompare(String(b.best_before || '9')));
  const held = lots.find((l) => l.status === 'hold');
  if (held) return `Lot ${held.code} is on hold (release it), or receive the delivery first.`;
  const late = lots.find((l) => (l.status == null || l.status === 'released') && l.best_before && !lotRules.eligible(l, 'pack', ctx.today, ctx.s) && lotRules.eligible(l, 'other', ctx.today, ctx.s));
  if (late) return `Lot ${late.code} is past its last ship date (${dateWords(lotRules.cutoffs(late.best_before, ctx.s).lastShip)}): it can only go to fairs, samples or offline sales.`;
  return 'Receive the delivery first.';
}
// The Packed refusal: one sentence per short flavour, e.g. "Kesari: 2 boxes short. Lot MNGK-261105-01 is on hold (release it), or receive the delivery first."
const shortText = (short) => (short || []).map((s) => `${String(s.name || s.slug).replace(/^Atta /, '')}: ${s.boxes} ${s.boxes === 1 ? 'box' : 'boxes'} short. ${s.hint}`).join(' ');

// Boxes of each flavour inside an order (gift sets opened up): { 'atta-kesari': 2, ... }
function boxesBySlug(items) {
  const out = {};
  for (const it of items || []) {
    const q = Number(it.quantity) || 0;
    for (const f of flavoursOf(it)) { const slug = slugOfToken(f.token); out[slug] = (out[slug] || 0) + q; }
  }
  return out;
}

// What the website may still sell per flavour: boxes on the shelf minus boxes already paid for but not yet packed (stock is only
// deducted at Packed). Only flavours that have stock recorded are included; an item nobody has counted yet is left alone.
// With `ctx` (from lotContext) only boxes in lots the website may sell count: released or legacy, and today before the website stop date.
// Without it every box counts, as before lots existed.
function computeSellable(items, byLotRows, committed, ctx) {
  const out = {}; const has = new Set(); const sum = {}; const total = {};
  for (const r of byLotRows) { has.add(r.item_slug); total[r.item_slug] = (total[r.item_slug] || 0) + r.qty; if (ctx && !eligibleRow(ctx, r, 'web')) continue; sum[r.item_slug] = (sum[r.item_slug] || 0) + r.qty; }
  // never more than is on the shelf: a lot that cannot be sold may have a negative balance
  for (const i of items) { if (i.kind === 'product' && i.active && has.has(i.slug)) out[i.slug] = (ctx ? Math.min(total[i.slug] || 0, sum[i.slug] || 0) : (sum[i.slug] || 0)) - ((committed || {})[i.slug] || 0); }
  return out;
}

// Boxes already paid for but not yet packed, per flavour. Only orders created on or after `from` count: earlier ones are pre-launch
// test orders (paid in the database, unknown to the live Razorpay account) and must not hold back real stock.
const ORDERS_FROM_DEFAULT = '2026-10-10T00:00:00+05:30';
function committedBoxes(rows, from) {
  const t0 = Date.parse(from || ORDERS_FROM_DEFAULT); const m = {};
  for (const r of rows || []) {
    if (!(Date.parse(r.created_at) >= t0)) continue;
    const b = boxesBySlug(r.items); for (const k of Object.keys(b)) m[k] = (m[k] || 0) + b[k];
  }
  return m;
}

// First flavour in a cart that asks for more boxes than can still be sold, or null. `sellable(slug)` returns a number, or null when
// the flavour has no stock recorded (then it is never limited).
function firstShortage(cartItems, sellable) {
  const need = boxesBySlug(cartItems.map((c) => ({ slug: c.slug, quantity: c.qty })));
  for (const [slug, boxes] of Object.entries(need)) { const have = sellable(slug); if (have != null && boxes > have) return { slug, have: Math.max(0, have), boxes }; }
  return null;
}

function makeInventory(store, { now = () => Date.now() } = {}) {
  // Biscuits: the sum of the whole ledger. Packaging is hand-kept: its count is the sum of the lines on or after packaging_count_from
  // (nothing is deleted; earlier lines stay in History), and an item with no line since then has no count (`any` false). No setting = no reset.
  async function onHandMap() {
    const [rows, items, raw] = await Promise.all([store.byLot(), store.items(), orMissing(Promise.resolve().then(() => store.settingsAll()), {})]);   // rows: [{item_slug, lot_code, best_before, qty}]; settings missing (I1): no packaging reset
    const from = tsMs(lotRules.readSettings(raw).packaging_count_from);
    const pack = new Set(from == null ? [] : items.filter((i) => i.kind === 'packaging').map((i) => i.slug));
    const map = {};
    for (const r of rows) { if (pack.has(r.item_slug)) continue; const m = map[r.item_slug] || (map[r.item_slug] = { total: 0, lots: [], any: false }); m.total += r.qty; m.any = true; m.lots.push({ lot_code: r.lot_code, best_before: r.best_before, qty: r.qty }); }
    if (pack.size) for (const t of await store.totalsSince(new Date(from).toISOString(), [...pack])) map[t.item_slug] = { total: t.qty, lots: [{ lot_code: null, best_before: null, qty: t.qty }], any: true, last: t.last || null };
    // A typed count (counted_at, on or after the reset) makes the item counted even with no ledger line, e.g. a count of 0.
    for (const i of items) {
      const at = i.kind === 'packaging' ? tsMs(i.counted_at) : null;
      if (at == null || (from != null && at < from)) continue;
      const m = map[i.slug] || (map[i.slug] = { total: 0, lots: [], any: true });
      m.any = true; if (!m.last || at > Date.parse(m.last)) m.last = new Date(at).toISOString();
    }
    return map;
  }

  function statusOf(item, m) {
    if (item.manual_low) return 'low';
    if (!m || !m.any) return 'new';
    if (item.kind === 'packaging') {   // alerts only when a low level is set; "no count" (above) is never an alert, and 0 with no low level is fine
      if (!(item.low_level > 0)) return 'ok';
      return m.total <= 0 ? 'out' : m.total <= item.low_level ? 'low' : 'ok';
    }
    if (m.total <= 0) return 'out';
    if (item.low_level > 0 && m.total <= item.low_level) return 'low';
    return 'ok';
  }

  async function overview() {
    const [items, map, ev, committed, paused, ctx] = await Promise.all([store.items(), onHandMap(), store.events(), store.committed().catch(() => ({})), store.paused().catch(() => []), lotContext(store, now())]);
    const outAt = {}; const events = {};
    for (const e of ev) { const out = e.taken - e.returned; if (out <= 0) continue; outAt[e.item_slug] = (outAt[e.item_slug] || 0) + out; (events[e.ref] = events[e.ref] || []).push({ slug: e.item_slug, taken: e.taken, returned: e.returned, out }); }
    const list = items.filter((i) => i.active).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)).map((i) => {
      const m = map[i.slug];
      const lotList = m ? m.lots.filter((l) => l.qty !== 0).sort((a, b) => String(a.best_before || '9').localeCompare(String(b.best_before || '9'))).map((l) => {
        const info = lotInfo(ctx, { item_slug: i.slug, lot_code: l.lot_code, best_before: l.best_before }); const c = lotRules.cutoffs(info.best_before, ctx.s);
        // lot: the lot these boxes belong to (an alias row names its lot); owner_hold: held by the owner, not a new delivery (I2)
        return { ...l, status: info.status || 'legacy', lot: info.lot || l.lot_code, owner_hold: !!info.ownerHold, lastShip: c ? c.lastShip : null, websiteStop: c ? c.websiteStop : null };
      }) : [];
      const elig = (purpose) => (m ? m.lots.filter((l) => eligibleRow(ctx, { item_slug: i.slug, lot_code: l.lot_code, best_before: l.best_before }, purpose)).reduce((n, l) => n + l.qty, 0) : 0);
      const usable = i.kind === 'product' ? (m ? Math.min(m.total, elig('other')) : 0) : null;
      const webBoxes = i.kind === 'product' && m && m.any ? Math.min(m.total, elig('web')) : null;
      // boxes in lots on hold (Task 12): on the shelf, not on the website, so a flavour whose stock is all held never looks fine silently
      const onHold = i.kind === 'product' ? Math.max(0, lotList.filter((l) => l.status === 'hold').reduce((n, l) => n + l.qty, 0)) : null;
      return { slug: i.slug, name: i.name, kind: i.kind, unit: i.unit, low_level: i.low_level, manual_low: !!i.manual_low, on_hand: m ? m.total : 0, usable, on_hold: onHold, committed: committed[i.slug] || 0, sellable: webBoxes == null ? null : webBoxes - (committed[i.slug] || 0), paused: paused.includes(i.slug), at_events: outAt[i.slug] || 0, counted: !!(m && m.any), last_counted: i.kind === 'packaging' && m && m.last ? m.last : null, status: statusOf(i, m), lots: lotList };
    });
    const nameOf = Object.fromEntries(items.map((i) => [i.slug, i.name]));
    const open = Object.keys(events).map((ref) => ({ ref, items: events[ref].map((x) => ({ ...x, name: nameOf[x.slug] || x.slug })) }));
    return { items: list, events: open, low: list.filter((i) => i.status === 'low' || i.status === 'out').map((i) => ({ slug: i.slug, name: i.name, status: i.status, on_hand: i.on_hand })) };
  }

  async function need(slug) {
    const item = await store.item(slug);
    if (!item || !item.active) throw new StockError('No such item.', 404);
    return item;
  }
  async function onHand(slug) { const map = await onHandMap(); return map[slug] ? map[slug].total : 0; }
  // Boxes a take-out may use: on hand, less what is on hold or past best before. Packaging has no lots, so all of it counts.
  // `held` is how many more boxes are on the shelf but not usable (never negative: a lot-less shortfall row is not "held").
  async function usableOf(item, ctx, purpose = 'other') {
    if (item.kind !== 'product') { const t = await onHand(item.slug); return { have: t, usable: t, held: 0 }; }   // packaging: the since-reset count
    const rows = (await store.byLot()).filter((r) => r.item_slug === item.slug);
    const total = rows.reduce((n, r) => n + r.qty, 0);
    const eligibleSum = rows.filter((r) => eligibleRow(ctx, r, purpose)).reduce((n, r) => n + r.qty, 0);
    const usable = Math.min(total, eligibleSum);
    return { have: total, usable, held: total - usable };
  }
  const shortMsg = (item, u) => (u.held > 0 ? `Only ${u.usable} ${item.unit} can be used (${u.held} more are ${HELD_NOTE}). Count first, or confirm to go below zero.` : `Only ${u.have} ${item.unit} on hand. Count first, or confirm to go below zero.`);
  // takeMany / hamper: when any item has boxes held back the sentence says "can be used", item by item; otherwise today's wording.
  const shortList = (short) => (short.some((x) => x.u.held > 0)
    ? 'Not enough can be used: ' + short.map((x) => (x.u.held > 0 ? `${x.item.name}: need ${x.q}, can use ${x.u.usable} (${x.u.held} more are ${HELD_NOTE})` : `${x.item.name}: need ${x.q}, have ${x.u.usable}`)).join('; ') + '. Count first, or confirm to go below zero.'
    : 'Not enough on hand: ' + short.map((x) => `${x.item.name}: need ${x.q}, have ${x.u.usable}`).join('; ') + '. Count first, or confirm to go below zero.');
  const who = (actor) => ({ actor_email: actor && actor.email || null, actor_name: actor && (actor.name || actor.email) || null });

  // Stock arrived: boxes received, how many of them damaged or not okay, lot, best-before, supplier challan, optional billing.
  // `replaces` = id of an earlier receipt this one corrects: the old line (and the damaged line saved with it) is cancelled
  // and the new one written in the same save, so a refused correction changes nothing.
  async function receive({ slug, received, damaged = 0, lot, bestBefore, ref, note, billedKg, amountRupees, confirmDuplicate = false, replaces = null, isOwner = false, actor, biscuitsViaDelivery = false }) {
    const item = await need(slug);
    // The admin route sets this: a new biscuit receipt there must go through Stock, New delivery (Task 10). A correction of an old receipt (`replaces`) is allowed.
    if (biscuitsViaDelivery && item.kind === 'product' && (replaces == null || replaces === '')) throw new StockError('Biscuits are received with Stock, New delivery, so every box gets its lot and the hold check.', 409);
    const rec = int(received), dmg = int(damaged || 0);
    if (!Number.isInteger(rec) || rec < 1 || rec > MAX_QTY) throw new StockError('Enter how many were received (a whole number, 1 or more).');
    if (!Number.isInteger(dmg) || dmg < 0 || dmg > rec) throw new StockError('Damaged cannot be more than received.');
    const lotCode = cleanText(lot, 40);
    if (item.kind === 'product' && !lotCode) throw new StockError('Enter the lot (for example the date it was prepared). It is how a complaint is traced.');
    if (lotCode && !validLot(lotCode)) throw new StockError('The lot can use letters, numbers, space and . - / only.');
    if (bestBefore && !validDate(bestBefore)) throw new StockError('Best before must be a date.');
    const kg = billedKg === '' || billedKg == null ? null : Number(billedKg);
    if (kg != null && (!(kg > 0) || kg > 100000)) throw new StockError('Billed weight must be a number of kg.');
    const amt = amountRupees === '' || amountRupees == null ? null : Number(amountRupees);
    if (amt != null && (!(amt >= 0) || amt > 100_000_000)) throw new StockError('Amount must be a number of rupees.');
    if (rec >= 5000 && !confirmDuplicate) throw new StockError(`${rec} is a very large number. If it is right, confirm.`, 409, { needsConfirm: 'large' });
    const replacing = replaces != null && replaces !== '';
    let old = null, oldDamaged = [];
    if (replacing) {
      old = await store.movement(Number(replaces));
      if (!old || old.type !== 'RECEIVE') throw new StockError('Only a receipt can be corrected.', 409);
      if (old.delivery_id != null) throw new StockError('This line came from a delivery. Use Correct whole delivery or Fix lot.', 409);
      if (old.item_slug !== slug) throw new StockError('A correction must be for the same product as the receipt it replaces.', 409);
      if (old.reverses_id || await store.reversalOf(old.id)) throw new StockError('This line was already reversed.', 409);
      if (!isOwner && Date.now() - Date.parse(old.created_at) > REVERSE_FREE_MS) throw new StockError('Only the owner can reverse a line older than a day.', 403);
      oldDamaged = await damagedWith(old);
    }
    if (!confirmDuplicate && !replacing) {
      const recent = await store.recent({ item_slug: slug, type: 'RECEIVE', since: new Date(Date.now() - DUP_WINDOW_MS).toISOString() });
      if (recent.some((r) => r.qty === rec && (r.lot_code || '') === lotCode)) throw new StockError('The same receipt was saved a moment ago. Save again only if it is a second delivery.', 409, { needsConfirm: 'duplicate' });
    }
    const base = { item_slug: slug, lot_code: lotCode || null, best_before: bestBefore || null, ref: cleanText(ref, 60) || null, ...who(actor) };
    const rows = [];
    if (old) [old, ...oldDamaged].forEach((m) => rows.push({ item_slug: m.item_slug, qty: -m.qty, type: 'REVERSAL', lot_code: m.lot_code, best_before: m.best_before, ref: m.ref, note: 'Corrected receipt', reverses_id: m.id, ...who(actor) }));
    rows.push({ ...base, type: 'RECEIVE', qty: rec, note: cleanText(note, 300) || null, billed_kg: kg, amount_paise: amt == null ? null : Math.round(amt * 100) });
    if (dmg) rows.push({ ...base, type: 'DAMAGED', qty: -dmg, note: cleanText(note, 300) || DAMAGED_ON_RECEIPT });
    await store.insert(rows);
    return { onHand: await onHand(slug), received: rec, damaged: dmg };
  }

  // Take stock out: used (packaging), damaged or not okay, or a sample/gift. Oldest lot first for products.
  async function take({ slug, qty, type, note, who: whoFor, invoice, lot = null, reason = null, allowNegative = false, actor }) {
    const item = await need(slug);
    if (!TYPES_OUT[type]) throw new StockError('Choose what happened: used, damaged, or sample.');
    if (reason != null && (type !== 'DAMAGED' || !DAMAGE_REASONS.has(reason))) throw new StockError('Choose why it was damaged: on the bus, at the bakery or while cartoning.');
    const n = int(qty);
    if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) throw new StockError('Enter a whole number, 1 or more.');
    if (type === 'DAMAGED' && !cleanText(note, 300)) throw new StockError('Add a short note on what was wrong.');
    const forWhom = cleanText(whoFor, 80);
    if (NEEDS_WHO[type] && !forWhom) throw new StockError(NEEDS_WHO[type]);
    const ctx = await lotContext(store, now());
    if (lot) await checkNamedLot(item, lot, ctx);
    const u = await usableOf(item, ctx);
    if (n > u.usable && !allowNegative) throw new StockError(shortMsg(item, u), 409, { needsConfirm: 'negative', onHand: u.have, usable: u.usable });
    const inv = cleanText(invoice, 40);
    if (type === 'OFFLINE_SALE' && !inv) throw new StockError('Enter the invoice number (write PENDING if it is not made yet and fix it later).');
    const base = type === 'OFFLINE_SALE' ? { type, note: cleanText(note, 300) || null, ref: inv, party: forWhom, ...who(actor) } : { type, note: cleanText(note, 300) || null, ref: forWhom || null, ...who(actor) };
    const rows = await outRows(item, n, base, { lot, ctx });
    await store.insert(reason ? rows.map((r) => ({ ...r, reason })) : rows);
    return { onHand: await onHand(slug) };
  }

  // Several items in one entry (e.g. all four flavours sold at a fair): one reason, one note, a count per item. Same checks as
  // take(); every line is checked before anything is written, so all of it happens or none of it.
  async function takeMany({ boxes = {}, type, note, who: whoFor, invoice, allowNegative = false, actor }) {
    if (!TYPES_OUT[type]) throw new StockError('Choose what happened: used, damaged, or sample.');
    if (type === 'DAMAGED' && !cleanText(note, 300)) throw new StockError('Add a short note on what was wrong.');
    const forWhom = cleanText(whoFor, 80);
    if (NEEDS_WHO[type] && !forWhom) throw new StockError(NEEDS_WHO[type]);
    const inv = cleanText(invoice, 40);
    if (type === 'OFFLINE_SALE' && !inv) throw new StockError('Enter the invoice number (write PENDING if it is not made yet and fix it later).');
    const plan = [];
    for (const [slug, b] of Object.entries(boxes || {})) {
      if (b === '' || b == null) continue;
      const q = int(b);
      if (!Number.isInteger(q) || q < 0 || q > MAX_QTY) throw new StockError('Enter whole numbers (0 or more) for each item.');
      if (q) plan.push({ item: await need(slug), qty: q });
    }
    if (!plan.length) throw new StockError('Enter how many of at least one item.');
    if (!allowNegative) {
      const short = []; const ctx = await lotContext(store, now());
      for (const x of plan) { const u = await usableOf(x.item, ctx); if (x.qty > u.usable) short.push({ item: x.item, q: x.qty, u }); }
      if (short.length) throw new StockError(shortList(short), 409, { needsConfirm: 'negative' });
    }
    const base = type === 'OFFLINE_SALE' ? { type, note: cleanText(note, 300) || null, ref: inv, party: forWhom, ...who(actor) } : { type, note: cleanText(note, 300) || null, ref: forWhom || null, ...who(actor) };
    const rows = [];
    for (const x of plan) rows.push(...await outRows(x.item, x.qty, base));
    await store.insert(rows);
    const lines = [];
    for (const x of plan) lines.push({ slug: x.item.slug, name: x.item.name, qty: x.qty, onHand: await onHand(x.item.slug) });
    return { type, lines };
  }

  // A hamper sold offline. Only the biscuit boxes come off stock (whole boxes opened, per flavour); bag, candle and paper are not tracked.
  // The hamper's name and count go in the note so the history shows how many hampers went. One entry: all of it happens or none of it.
  async function offlineHamper({ hamper, hampers, boxes = {}, buyer, invoice, note, allowNegative = false, actor }) {
    const n = int(hampers);
    if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) throw new StockError('Enter how many hampers were sold (a whole number, 1 or more).');
    const name = cleanText(hamper, 60); if (!name) throw new StockError('Enter which hamper it was.');
    const who1 = cleanText(buyer, 80); if (!who1) throw new StockError('Enter who bought them.');
    const inv = cleanText(invoice, 40); if (!inv) throw new StockError('Enter the invoice number (write PENDING if it is not made yet and fix it later).');
    const plan = [];   // { item, qty }
    for (const [slug, b] of Object.entries(boxes)) { const q = int(b || 0); if (!q) continue; if (!Number.isInteger(q) || q < 0 || q > MAX_QTY) throw new StockError('Boxes opened must be whole numbers.'); const item = await need(slug); if (item.kind !== 'product') throw new StockError('Only biscuit boxes are counted for hampers.'); plan.push({ item, qty: q }); }
    if (!plan.length) throw new StockError('Enter how many boxes you opened for these hampers, so the biscuits are taken off stock.');
    if (!allowNegative) {
      const short = []; const ctx = await lotContext(store, now());
      for (const x of plan) { const u = await usableOf(x.item, ctx); if (x.qty > u.usable) short.push({ item: x.item, q: x.qty, u }); }
      if (short.length) throw new StockError(shortList(short), 409, { needsConfirm: 'negative' });
    }
    const tag = `Hamper: ${name} x ${n}`, extra = cleanText(note, 200);
    const base = { type: 'OFFLINE_SALE', ref: inv, party: who1, note: extra ? `${tag}. ${extra}` : tag, ...who(actor) };
    const rows = [];
    for (const x of plan) rows.push(...await outRows(x.item, x.qty, base));
    await store.insert(rows);
    return { hamper: name, hampers: n, lines: plan.map((x) => ({ slug: x.item.slug, name: x.item.name, qty: x.qty })) };
  }

  // Where did the stock go? Per flavour: what came in, and where each box went. Reversals are netted into the line they cancel.
  const FLOW = { RECEIVE: 'received', RETURN: 'returns', SALE: 'website', SALE_UNDO: 'website', OFFLINE_SALE: 'offline', EVENT_SALE: 'event_sales', GIFT: 'gifts', SAMPLE: 'samples',
    EXHIBITION: 'events', EXHIBITION_RETURN: 'events', DAMAGED: 'damaged', USE: 'used', COUNT_FIX: 'fixes' };
  async function flow() {
    const [items, totals, map] = await Promise.all([store.items(), store.totals(), onHandMap()]);
    const out = items.filter((i) => i.active && i.kind === 'product').sort((a, b) => a.sort - b.sort).map((i) => {
      const g = { received: 0, returns: 0, website: 0, offline: 0, event_sales: 0, gifts: 0, samples: 0, events: 0, damaged: 0, used: 0, fixes: 0, other: 0 };
      for (const t of totals) if (t.item_slug === i.slug) { const k = FLOW[t.type] || 'other'; g[k] += t.qty; }
      const m = map[i.slug];
      // "out" groups are stored negative; show them as positive boxes. Received, returns and fixes keep their sign.
      return { slug: i.slug, name: i.name, unit: i.unit, received: g.received, returns: g.returns, website: -g.website, offline: -g.offline, event_sales: -g.event_sales, gifts: -g.gifts, samples: -g.samples, events: -g.events, damaged: -g.damaged, used: -g.used, fixes: g.fixes, other: g.other, on_hand: m ? m.total : 0 };
    });
    return { items: out };
  }

  // A named lot must be a lot of this product, not on hold, and not past its best before.
  async function checkNamedLot(item, lot, ctx) {
    const rows = (await store.byLot()).filter((r) => r.item_slug === item.slug && r.lot_code === lot);
    if (!rows.length && !ctx.meta[`${item.slug}|${lot}`]) throw new StockError(`${lot} is not a lot of ${item.name}.`, 409);
    const infos = rows.map((r) => lotInfo(ctx, r)); const m = ctx.meta[`${item.slug}|${lot}`];
    const status = m ? m.status : null;
    if (status === 'hold' || status === 'rejected' || status === 'void') throw new StockError(`Lot ${lot} is on hold`, 409);
    const bbs = (m && m.best_before ? [m.best_before] : []).concat(infos.map((x) => x.best_before).filter(Boolean)).sort();
    if (bbs.length && ctx.today > bbs[0]) throw new StockError(`Lot ${lot} is past best before: use Throw away expired`, 409);
  }

  // Rows that remove n from stock: split across lots (oldest best-before first) for products; one plain row for packaging.
  // Only lots that are released or legacy and still inside the window for `purpose` are used. With `lot`, that lot goes first and
  // the rest (if it cannot cover n) comes from the other usable lots. Whatever the lots cannot cover becomes a lot-less line.
  async function outRows(item, n, base, { purpose = 'other', lot = null, ctx = null } = {}) {
    if (item.kind !== 'product') return [{ ...base, item_slug: item.slug, qty: -n, lot_code: null, best_before: null }];
    const c = ctx || await lotContext(store, now());
    const all = (await store.byLot()).filter((r) => r.item_slug === item.slug);
    const usable = all.filter((r) => eligibleRow(c, r, purpose));
    let pieces = [], short = n;
    if (lot) {
      await checkNamedLot(item, lot, c);
      const first = allocate(usable.filter((r) => r.lot_code === lot), n); pieces = first.pieces; short = first.short;
    }
    if (short > 0) { const rest = allocate(usable.filter((r) => !lot || r.lot_code !== lot), short); pieces = pieces.concat(rest.pieces); short = rest.short; }
    const rows = pieces.map((p) => ({ ...base, item_slug: item.slug, qty: -p.qty, lot_code: p.lot_code, best_before: p.best_before }));
    if (short > 0) rows.push({ ...base, item_slug: item.slug, qty: -short, lot_code: null, best_before: null });
    return rows;
  }

  // A biscuit count-up names the lot the extra boxes belong to (final review I3): a lot of that flavour, own code or alias resolved as
  // everywhere else, not rejected or corrected (a held lot is fine: the boxes stay held). Lot-less boxes would be sold by the website and
  // refused by packing.
  async function countLot(item, lot) {
    const code = cleanText(lot, 60);
    if (!code) throw new StockError('Choose which lot the extra boxes belong to.');
    const [lotRows, ledger] = await Promise.all([orMissing(Promise.resolve().then(() => store.lots()), []), store.byLot()]);
    const t = await lotOf(item.slug, code, { lotRows: lotRows || [], ledger: ledger || [] });
    if (!t) throw new StockError(`${code} is not a lot of ${item.name}.`, 409);
    if (t.status === 'rejected' || t.status === 'void') throw new StockError(`Lot ${t.lot_code} was rejected or corrected, so boxes cannot be added to it.`, 409);
    return t;
  }

  // Physical count: type what is on the shelf; the difference is written as one COUNT_FIX line with a note. A biscuit count higher than
  // on hand needs `lot` (countLot); count-downs come off the usable lots, oldest first, as before.
  async function count({ slug, counted, note, lot = null, actor }) {
    const item = await need(slug);
    const c = int(counted);
    if (!Number.isInteger(c) || c < 0 || c > MAX_QTY) throw new StockError('Enter the number you counted (0 or more).');
    const have = await onHand(slug);
    const diff = c - have;
    // Packaging: typing a count always records it (counted_at), even 0 and even the same number; the ledger line is written only when the number changes.
    const stamp = () => (item.kind === 'packaging' ? store.updateItem(slug, { counted_at: new Date().toISOString() }) : null);
    if (diff === 0) { await stamp(); return { onHand: have, diff: 0 }; }
    const nt = cleanText(note, 300);
    if (!nt) throw new StockError(`The system says ${have}, you counted ${c}. Add a short note on why (breakage, miscount, sample...).`, 400, { diff, onHand: have });
    const base = { type: 'COUNT_FIX', note: nt, ...who(actor) };
    let rows;
    if (diff > 0 && item.kind === 'product') { const t = await countLot(item, lot); rows = [{ ...base, item_slug: slug, qty: diff, lot_code: t.lot_code, best_before: t.best_before || null }]; }
    else rows = diff > 0 ? [{ ...base, item_slug: slug, qty: diff, lot_code: null, best_before: null }] : await outRows(item, -diff, base);
    await store.insert(rows);
    await stamp();
    return { onHand: await onHand(slug), diff };
  }

  // Unsold boxes come back from an exhibition or event: put back into the same lots they left from.
  async function eventReturn({ slug, qty, ref, note, actor }) {
    const item = await need(slug);
    const n = int(qty), evt = cleanText(ref, 80);
    if (!evt) throw new StockError('Choose the event.');
    if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) throw new StockError('Enter how many came back (a whole number, 1 or more).');
    const rows = await store.eventRows(evt, slug);
    const byLot = {};
    for (const r of rows) { const k = `${r.lot_code || ''}|${r.best_before || ''}`; const e = byLot[k] || (byLot[k] = { lot_code: r.lot_code, best_before: r.best_before, qty: 0 }); e.qty += -r.qty; }   // taken rows are negative and returns positive, so this is taken minus returned, per lot
    const lots = Object.values(byLot);
    const stillOut = lots.reduce((a, l) => a + l.qty, 0);
    if (n > stillOut) throw new StockError(stillOut > 0 ? `Only ${stillOut} ${item.unit} are still out at ${evt}.` : `Nothing is out at ${evt} for ${item.name}.`, 409);
    const { pieces } = allocate(lots, n);
    await store.insert(pieces.map((p) => ({ item_slug: slug, qty: p.qty, type: 'EXHIBITION_RETURN', lot_code: p.lot_code, best_before: p.best_before, ref: evt, note: cleanText(note, 300) || null, ...who(actor) })));
    return { onHand: await onHand(slug), stillOut: stillOut - n };
  }

  async function setLow({ slug, low }) { await need(slug); await store.updateItem(slug, { manual_low: !!low }); return { ok: true }; }

  async function addItem({ name, kind, unit, lowLevel }) {
    const nm = cleanText(name, 60); if (!nm) throw new StockError('Give the item a name.');
    if (!['product', 'packaging'].includes(kind)) throw new StockError('Choose product or packaging.');
    const slug = nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!slug) throw new StockError('Use letters or numbers in the name.');
    // The name decides (case and spaces ignored): an active item with it blocks a second one; an archived packaging item comes back with its slug and history.
    const key = (v) => String(v == null ? '' : v).toLowerCase().replace(/\s+/g, '');
    const same = ((await store.items()) || []).filter((i) => key(i.name) === key(nm));
    if (same.some((i) => i.active)) throw new StockError('That item is already on the list.', 409);
    const had = same.find((i) => i.kind === 'packaging') || (same.length ? null : await store.item(slug));
    if (same.length && !had) throw new StockError('That item already exists.', 409);
    if (had) {
      if (had.active || had.kind !== 'packaging') throw new StockError('That item already exists.', 409);
      const back = { active: true, unit: cleanText(unit, 20) || had.unit };   // the name matched, so the item keeps its own spelling
      if (lowLevel != null && lowLevel !== '') back.low_level = Math.max(0, int(lowLevel) || 0);
      await store.updateItem(had.slug, back);
      return { slug: had.slug, restored: true };
    }
    await store.insertItem({ slug, name: nm, kind, unit: cleanText(unit, 20) || 'pcs', low_level: Math.max(0, int(lowLevel) || 0), sort: 90 });
    return { slug };
  }
  // Remove = archive (owner only): a packaging item leaves the screen and the pickers, its ledger lines stay, and adding the same name brings it back.
  async function removeItem({ slug, isOwner = false }) {
    if (!isOwner) throw new StockError('Only the owner can remove an item.', 403);
    const item = await need(slug);
    if (item.kind !== 'packaging') throw new StockError('Only packaging items can be removed. Biscuits stay.', 400);
    await store.updateItem(slug, { active: false });
    return { ok: true };
  }
  async function setLevel({ slug, lowLevel }) {
    await need(slug); const n = int(lowLevel);
    if (!Number.isInteger(n) || n < 0 || n > MAX_QTY) throw new StockError('Enter a whole number, 0 or more (0 = only the manual Low flag).');
    await store.updateItem(slug, { low_level: n }); return { ok: true };
  }

  // Cancel one earlier line by adding its opposite. Within 24 h anyone can; later only the owner. A line can be reversed once.
  async function reverse({ id, reason, actor, isOwner }) {
    const m = await store.movement(id);
    if (!m) throw new StockError('No such line.', 404);
    if (m.type === 'REVERSAL' || m.type === 'SALE' || m.type === 'SALE_UNDO') throw new StockError(m.type === 'REVERSAL' ? 'A reversal cannot be reversed. Enter the correct line instead.' : 'Sales are handled by the order. Use Undo on the order.', 409);
    if (m.delivery_id != null) throw new StockError('This line came from a delivery. Use Correct whole delivery or Fix lot.', 409);
    if (m.reverses_id || await store.reversalOf(id)) throw new StockError('This line was already reversed.', 409);
    const rs = cleanText(reason, 300); if (!rs) throw new StockError('Add a short reason.');
    if (!isOwner && Date.now() - Date.parse(m.created_at) > REVERSE_FREE_MS) throw new StockError('Only the owner can reverse a line older than a day.', 403);
    await store.insert([{ item_slug: m.item_slug, qty: -m.qty, type: 'REVERSAL', lot_code: m.lot_code, best_before: m.best_before, ref: m.ref, note: rs, reverses_id: m.id, ...who(actor) }]);
    return { ok: true };
  }

  // The damaged boxes written in the same save as a receipt: same product and lot, same moment, the receipt's note (or the standard one), not yet cancelled.
  async function damagedWith(m) {
    const near = await store.recent({ item_slug: m.item_slug, type: 'DAMAGED', since: new Date(Date.parse(m.created_at) - 2000).toISOString(), limit: 200 });
    const mine = near.filter((r) => !r.reverses_id && Math.abs(Date.parse(r.created_at) - Date.parse(m.created_at)) <= 2000 && (r.lot_code || '') === (m.lot_code || '') && r.note === (m.note || DAMAGED_ON_RECEIPT));
    const done = new Set(await store.reversedAmong(mine.map((r) => r.id)));
    return mine.filter((r) => !done.has(r.id));
  }

  // What the Correct form needs to refill itself from an earlier receipt.
  async function receipt({ id }) {
    const m = await store.movement(Number(id));
    if (!m || m.type !== 'RECEIVE') throw new StockError('Only a receipt can be corrected.', 409);
    const damaged = (await damagedWith(m)).reduce((n, r) => n - r.qty, 0);
    const reversed = !!m.reverses_id || await store.reversalOf(m.id);
    return { id: m.id, slug: m.item_slug, received: m.qty, damaged, lot: m.lot_code || '', bestBefore: m.best_before || '', ref: m.ref || '', note: m.note || '', billedKg: m.billed_kg == null ? '' : Number(m.billed_kg), amountRupees: m.amount_paise == null ? '' : m.amount_paise / 100, reversed };
  }

  // Fix a mistyped lot code (15Oct26 -> 15OCT26): what is left in the lot moves to the right code with two COUNT_FIX lines, out of the
  // old lot and into the new one, best-before carried over. Rows are never edited, so past sales keep the lot they were typed under
  // and the total on hand does not change. Owner only.
  async function renameLot({ slug, from, to, actor, isOwner = false }) {
    if (!isOwner) throw new StockError('Only the owner can rename a lot.', 403);
    const item = await store.item(slug); if (!item) throw new StockError('No such item.', 404);
    // Final review C2: rows moved to a new code had no lot row, so they counted as released and slipped past a hold. A biscuit lot is
    // fixed with Fix lot (deliveries.fixLot), which moves the lot row too and keeps the old code as an alias.
    if (item.kind === 'product') throw new StockError('Biscuit lots are fixed with Fix lot on the lot page, so the hold and the dates follow the lot.', 409);
    const oldCode = cleanText(from, 40), newCode = cleanText(to, 40);
    if (!newCode || !validLot(newCode)) throw new StockError('The lot can use letters, numbers, space and . - / only.');
    if (oldCode === newCode) throw new StockError('The new lot code must be different from the old one.');
    const groups = (await store.byLot()).filter((r) => r.item_slug === slug && (r.lot_code || '') === oldCode && r.qty !== 0);
    if (!groups.length) throw new StockError(`There is no stock in lot ${oldCode || '(none)'} to move.`, 409);
    const note = `Lot renamed ${oldCode || '(none)'} to ${newCode}`;
    const rows = [];
    groups.forEach((g) => rows.push(
      { item_slug: slug, type: 'COUNT_FIX', qty: -g.qty, lot_code: oldCode || null, best_before: g.best_before || null, note, ...who(actor) },
      { item_slug: slug, type: 'COUNT_FIX', qty: g.qty, lot_code: newCode, best_before: g.best_before || null, note, ...who(actor) }));
    await store.insert(rows);
    return { moved: groups.reduce((n, g) => n + g.qty, 0), from: oldCode, to: newCode };
  }

  // `types` narrows the list (Received only, Sales only...): receipts were being pushed out of the latest 60 lines by packed orders.
  async function history({ slug, limit = 40, types }) {
    const t = (Array.isArray(types) ? types : []).filter((x) => HISTORY_TYPES.has(x));
    const movements = await store.recent({ item_slug: slug || null, types: t.length ? t : null, limit: Math.min(200, Math.max(1, limit)) });
    const done = new Set(await store.reversedAmong(movements.map((m) => m.id)));
    return { movements: movements.map((m) => ({ ...m, reversed: done.has(m.id) })) };
  }

  // ── Orders ──────────────────────────────────────────────────────────────────
  // Packing (spec 6.6), worked out BEFORE the order is saved as packed: which lots the boxes come from. Only lots that are released or
  // legacy and on or before their last ship date on the day of the pack (`at`, India date) are used, oldest best before first, each lot
  // whole (packLots); stock with no lot is never packed. What they cannot cover is `short`, with a plain hint; the caller refuses the
  // Packed step unless the owner overrides. A flavour with no ledger rows at all has never been counted, so it is not limited (as on
  // the website): it gets a lot-less line, as before lots. Writes nothing.
  async function planForOrder({ items, at = new Date().toISOString() }) {
    const from = await store.setting('tracking_from');
    if (!from || Date.parse(at) < Date.parse(from)) return { skipped: 'before tracking started', rows: [], short: [] };
    const boxes = boxesBySlug(items); const slugs = Object.keys(boxes);
    if (!slugs.length) return { skipped: 'no tracked items', rows: [], short: [] };
    const [list, all, ctx] = await Promise.all([store.items(), store.byLot(), lotContext(store, Date.parse(at))]);
    const products = new Map(list.filter((i) => i.kind === 'product').map((i) => [i.slug, i]));
    const rows = [], short = [];
    for (const slug of slugs) {
      const item = products.get(slug); if (!item) continue;
      const mine = all.filter((r) => r.item_slug === slug);
      if (!mine.length) { rows.push({ item_slug: slug, qty: -boxes[slug], type: 'SALE', lot_code: null, best_before: null }); continue; }
      const { pieces, short: left } = allocate(packLots(mine).filter((l) => eligibleRow(ctx, l, 'pack')), boxes[slug]);
      pieces.forEach((p) => rows.push({ item_slug: slug, qty: -p.qty, type: 'SALE', lot_code: p.lot_code, best_before: p.best_before }));
      if (left > 0) short.push({ slug, name: item.name, boxes: left, hint: packHint(ctx, mine) });
    }
    return { rows, short };
  }
  // Called after an order is marked Packed. With `plan` (from planForOrder) it writes the plan, and the short boxes as one lot-less
  // line per flavour, noted when the owner overrode ("needs lot" until Assign lot). Without a plan (planning failed) it works as before
  // lots: deducts only from tracking_from onward; oldest lot first; a shortfall becomes a lot-less line so stock shows below zero
  // (a clear signal) instead of the pack failing.
  async function deductForOrder({ orderId, items, at = new Date().toISOString(), plan = null, overrideNote = null }) {
    if (plan) {
      if (plan.skipped) return { skipped: plan.skipped };
      const ref = `${orderId}@${at}`; const why = cleanText(overrideNote, 250);
      // one row per flavour and lot, as the database requires: the plan has one line per lot, no lot-less line for a flavour that is short
      const rows = (plan.rows || []).map((r) => ({ ...r, ref }));
      for (const s of plan.short || []) rows.push({ item_slug: s.slug, qty: -s.boxes, type: 'SALE', lot_code: null, best_before: null, ref, note: why ? `Packed without a lot (owner): ${why}` : null });
      if (rows.length) await store.insert(rows);
      return { rows: rows.length };
    }
    const from = await store.setting('tracking_from');
    if (!from || Date.parse(at) < Date.parse(from)) return { skipped: 'before tracking started' };
    const boxes = boxesBySlug(items); const slugs = Object.keys(boxes);
    if (!slugs.length) return { skipped: 'no tracked items' };
    const known = new Set((await store.items()).filter((i) => i.kind === 'product').map((i) => i.slug));
    const all = await store.byLot(); const ref = `${orderId}@${at}`; const rows = [];
    for (const slug of slugs) {
      if (!known.has(slug)) continue;
      // one sale per lot (the database allows one per pack, flavour and lot): a lot split over two best-before lines is summed with its
      // earliest best before, as packLots does, and the boxes with no lot and the shortfall share one lot-less line
      const groups = new Map();
      for (const r of all.filter((x) => x.item_slug === slug)) {
        const k = r.lot_code == null ? '' : r.lot_code, e = groups.get(k) || { lot_code: r.lot_code == null ? null : r.lot_code, best_before: null, qty: 0 };
        e.qty += r.qty; if (r.best_before && (!e.best_before || r.best_before < e.best_before)) e.best_before = r.best_before;
        groups.set(k, e);
      }
      const { pieces, short } = allocate([...groups.values()], boxes[slug]);
      const mine = pieces.map((p) => ({ item_slug: slug, qty: -p.qty, type: 'SALE', lot_code: p.lot_code, best_before: p.best_before, ref }));
      if (short > 0) { const none = mine.find((x) => x.lot_code == null); if (none) none.qty -= short; else mine.push({ item_slug: slug, qty: -short, type: 'SALE', lot_code: null, best_before: null, ref }); }
      rows.push(...mine);
    }
    if (rows.length) await store.insert(rows);
    return { rows: rows.length };
  }
  // Called when a Packed order is stepped back: puts back exactly what that pack took, to the same lots.
  async function restoreForOrder({ orderId }) {
    const sales = await store.salesOf(orderId);   // SALE and SALE_UNDO rows for this order
    const undone = new Set(sales.filter((r) => r.type === 'SALE_UNDO').map((r) => `${r.ref}|${r.item_slug}|${r.lot_code || ''}`));
    const rows = sales.filter((r) => r.type === 'SALE' && !undone.has(`${r.ref}|${r.item_slug}|${r.lot_code || ''}`))
      .map((r) => ({ item_slug: r.item_slug, qty: -r.qty, type: 'SALE_UNDO', lot_code: r.lot_code, best_before: r.best_before, ref: r.ref }));
    if (rows.length) await store.insert(rows);
    return { rows: rows.length };
  }

  // Boxes packed without a lot since lots began (an owner override, or a pack whose plan failed), not yet undone or assigned:
  // what Needs attention lists. lots_from and created_at are compared as times (the database keeps lots_from as now()::text).
  async function needsLot() {
    const from = Date.parse(await store.setting('lots_from'));
    if (!Number.isFinite(from)) return [];
    const rows = (await store.lotlessSales(new Date(from).toISOString())) || [];
    const undone = new Set(rows.filter((r) => r.type === 'SALE_UNDO').map((r) => `${r.ref}|${r.item_slug}`));
    return rows.filter((r) => r.type === 'SALE' && r.lot_code == null && Date.parse(r.created_at) > from && !undone.has(`${r.ref}|${r.item_slug}`))
      .map((r) => { const ref = String(r.ref || ''); const i = ref.indexOf('@'); return { orderId: i >= 0 ? ref.slice(0, i) : ref, slug: r.item_slug, boxes: -r.qty, packedAt: i >= 0 ? ref.slice(i + 1) : r.created_at }; })
      .sort((a, b) => Date.parse(a.packedAt) - Date.parse(b.packedAt));
  }

  // The lot a code (or alias) names for one flavour (R5), resolved as everywhere else (lots.resolveCode: exact own code, then own code
  // ignoring case, then an alias): its own code, status (null = legacy), best before and boxes on hand under all its codes; null if none.
  async function lotOf(slug, code, { lotRows = null, ledger = null } = {}) {
    const rows = lotRows || (await store.lots()) || [];
    const mine = (ledger || (await store.byLot()) || []).filter((r) => r.item_slug === slug);
    const hit = lotRules.resolveCode(rows, mine, code, slug)[0];
    if (!hit) return null;
    const codes = hit.row ? lotRules.codesOfLot(lotRules.lotIndex(rows), hit.row) : [hit.code];
    const groups = mine.filter((r) => codes.includes(r.lot_code));
    const bbs = groups.map((g) => g.best_before).filter(Boolean).sort();
    return { lot_code: hit.code, status: hit.row ? hit.row.status : null, best_before: (hit.row && hit.row.best_before) || bbs[0] || null, onHand: groups.reduce((n, g) => n + g.qty, 0) };
  }

  // Owner: give a lot to the boxes of an order that were packed without one (spec 6.6). Each lot-less sale of that order and flavour
  // that is not undone gets a SALE_UNDO (lot-less) and a SALE on the chosen lot under the same ref, so Undo on the order still puts
  // back exactly what the pack took, now to the right lot.
  async function assignLot({ orderId, slug, lot, isOwner = false, actor } = {}) {
    if (!isOwner) throw new StockError('Only the owner can assign a lot.', 403);
    const item = await need(slug);
    if (item.kind !== 'product') throw new StockError('Only biscuit boxes have lots.');
    const code = cleanText(lot, 60); if (!code) throw new StockError('Choose the lot.');
    const sales = await store.salesOf(cleanText(orderId, 80));
    const key = (r) => `${r.ref}|${r.item_slug}|${r.lot_code || ''}`;
    const undone = new Set(sales.filter((r) => r.type === 'SALE_UNDO').map(key));
    const open = sales.filter((r) => r.type === 'SALE' && r.item_slug === slug && r.lot_code == null && !undone.has(key(r)));
    if (!open.length) throw new StockError(`No ${item.name} boxes of this order are waiting for a lot.`, 409);
    const target = await lotOf(slug, code);
    if (!target) throw new StockError(`${code} is not a lot of ${item.name}.`, 404);
    const ctx = await lotContext(store, now());
    if (!lotRules.eligible(target, 'pack', ctx.today, ctx.s)) {
      if (target.status === 'hold') throw new StockError(`Lot ${target.lot_code} is on hold. Release it first, or choose another lot.`, 409);
      if (target.status != null && target.status !== 'released') throw new StockError(`Lot ${target.lot_code} was rejected or corrected, so it cannot be used.`, 409);
      throw new StockError(`Lot ${target.lot_code} is past its last ship date (${dateWords(lotRules.cutoffs(target.best_before, ctx.s).lastShip)}), so it cannot go to a website order. Choose another lot.`, 409);
    }
    // R4: the database allows one sale per order pack, flavour and lot
    if (open.some((r) => sales.some((x) => x.type === 'SALE' && x.ref === r.ref && x.item_slug === slug && x.lot_code === target.lot_code))) throw new StockError(`This pack already took boxes from lot ${target.lot_code}. Choose another lot, or undo the pack and pack again.`, 409);
    const needed = open.reduce((n, r) => n - r.qty, 0);
    if (target.onHand < needed) { const n = Math.max(0, target.onHand); throw new StockError(`Lot ${target.lot_code} has only ${n} ${n === 1 ? 'box' : 'boxes'} on hand; this order needs ${needed}.`, 409); }
    const rows = [];
    for (const r of open) rows.push(
      { item_slug: slug, qty: -r.qty, type: 'SALE_UNDO', lot_code: null, best_before: r.best_before || null, ref: r.ref, note: `Lot assigned: ${target.lot_code}`, ...who(actor) },
      { item_slug: slug, qty: r.qty, type: 'SALE', lot_code: target.lot_code, best_before: target.best_before, ref: r.ref, note: 'Lot assigned by the owner (packed without a lot)', ...who(actor) });
    await store.insert(rows);
    return { moved: needed, lot: target.lot_code };
  }

  // { slug: boxes still sellable } for the flavours that have stock recorded (used by utils/stock.js for the automatic sold-out).
  // Only boxes the website may sell count (released or legacy lots, before their website stop date).
  async function sellable() { const [items, rows, committed, ctx] = await Promise.all([store.items(), store.byLot(), store.committed(), lotContext(store, now())]); return computeSellable(items, rows, committed, ctx); }

  return { overview, sellable, receive, receipt, renameLot, take, takeMany, offlineHamper, flow, count, eventReturn, setLow, addItem, removeItem, setLevel, reverse, history, planForOrder, deductForOrder, restoreForOrder, needsLot, assignLot };
}

// ── Real storage (Supabase) ───────────────────────────────────────────────────
function supabaseStore() {
  const c = () => require('./database').client();
  const ok = ({ data, error }) => {
    if (error) {
      const missing = error.code === '42P01' || /does not exist|schema cache/.test(error.message);
      if (missing && /stock_lots|stock_deliveries|stock_save_delivery|delivery_id|counted_at/.test(error.message)) throw new Error('Run batch_receiving_migration.sql in Supabase first.');   // not the bill-once clash: that is a 23505, not a missing table
      throw new Error(missing ? (/party|stock_totals/.test(error.message) ? 'Run stock_offline_migration.sql in Supabase first.' : 'Run stock_ledger_migration.sql in Supabase first.') : (/stock_movements_type_check/.test(error.message) ? 'Run stock_offline_migration.sql in Supabase first.' : error.message));
    }
    return data;
  };
  const like = (v) => String(v).replace(/[\\%_]/g, '\\$&');   // exact, case-insensitive match through ilike
  return {
    items: async () => ok(await c().from('stock_items').select('*')) || [],
    item: async (slug) => ok(await c().from('stock_items').select('*').eq('slug', slug).maybeSingle()) || null,
    byLot: async () => ok(await c().from('stock_by_lot').select('*')) || [],
    insert: async (rows) => { ok(await c().from('stock_movements').insert(rows)); },
    recent: async ({ item_slug, type, types, since, limit = 50 }) => {
      let q = c().from('stock_movements').select('*').order('created_at', { ascending: false }).limit(limit);
      if (item_slug) q = q.eq('item_slug', item_slug); if (type) q = q.eq('type', type); if (types && types.length) q = q.in('type', types); if (since) q = q.gte('created_at', since);
      return ok(await q) || [];
    },
    movement: async (id) => ok(await c().from('stock_movements').select('*').eq('id', id).maybeSingle()) || null,
    reversalOf: async (id) => !!ok(await c().from('stock_movements').select('id').eq('reverses_id', id).maybeSingle()),
    reversedAmong: async (ids) => (ids.length ? (ok(await c().from('stock_movements').select('reverses_id').in('reverses_id', ids)) || []).map((r) => r.reverses_id) : []),
    updateItem: async (slug, fields) => { ok(await c().from('stock_items').update(fields).eq('slug', slug)); },
    insertItem: async (row) => { ok(await c().from('stock_items').insert(row)); },
    setting: async (key) => { const r = ok(await c().from('stock_settings').select('value').eq('key', key).maybeSingle()); return r ? r.value : null; },
    committed: async () => {
      const rows = ok(await c().from('orders').select('items, created_at').eq('status', 'paid').is('packed_at', null)) || [];
      const from = ok(await c().from('stock_settings').select('value').eq('key', 'orders_from').maybeSingle());
      return committedBoxes(rows, from && from.value);
    },
    paused: async () => (ok(await c().from('product_stock').select('slug').eq('available', false)) || []).map((r) => r.slug),
    totals: async () => ok(await c().from('stock_totals').select('*')) || [],
    // Packaging counts: per slug with at least one line on or after `ts`, the sum of those lines and the newest time. Paged, so the 1000-row cap never cuts a sum short.
    totalsSince: async (ts, slugs) => {
      if (!slugs.length) return [];
      const m = {};
      for (let from = 0; ; from += 1000) {
        const page = ok(await c().from('stock_movements').select('item_slug, qty, created_at').gte('created_at', ts).in('item_slug', slugs).order('id', { ascending: true }).range(from, from + 999)) || [];
        for (const r of page) { const e = m[r.item_slug] || (m[r.item_slug] = { item_slug: r.item_slug, qty: 0, last: r.created_at }); e.qty += r.qty; if (Date.parse(r.created_at) > Date.parse(e.last)) e.last = r.created_at; }
        if (page.length < 1000) break;
      }
      return Object.values(m);
    },
    events: async () => ok(await c().from('stock_events').select('*')) || [],
    eventRows: async (ref, slug) => ok(await c().from('stock_movements').select('*').eq('ref', ref).eq('item_slug', slug).in('type', ['EXHIBITION', 'EXHIBITION_RETURN'])) || [],
    salesOf: async (orderId) => ok(await c().from('stock_movements').select('*').like('ref', `${orderId}@%`).in('type', ['SALE', 'SALE_UNDO'])) || [],
    lotlessSales: async (since) => { let q = c().from('stock_movements').select('*').in('type', ['SALE', 'SALE_UNDO']).is('lot_code', null); if (since) q = q.gte('created_at', since); return ok(await q) || []; },
    // batch receiving (see batch_receiving_migration.sql)
    settingsAll: async () => Object.fromEntries((ok(await c().from('stock_settings').select('key, value')) || []).map((r) => [r.key, r.value])),
    lots: async () => ok(await c().from('stock_lots').select('*')) || [],
    lotsByCode: async (code) => {
      const [a, b] = [ok(await c().from('stock_lots').select('*').eq('lot_code', code)) || [], ok(await c().from('stock_lots').select('*').contains('aliases', [code])) || []];
      return a.concat(b.filter((x) => !a.some((y) => y.item_slug === x.item_slug && y.lot_code === x.lot_code)));
    },
    updateLot: async (slug, code, fields) => { ok(await c().from('stock_lots').update(fields).eq('item_slug', slug).eq('lot_code', code)); },
    insertLots: async (rows) => { ok(await c().from('stock_lots').insert(rows)); },
    delivery: async (id) => ok(await c().from('stock_deliveries').select('*').eq('id', id).maybeSingle()) || null,
    deliveriesByBill: async (supplier, billNo) => ok(await c().from('stock_deliveries').select('*').ilike('supplier', like(supplier)).ilike('bill_no', like(billNo))) || [],
    lastDelivery: async () => ok(await c().from('stock_deliveries').select('*').neq('status', 'void').order('created_at', { ascending: false }).limit(1).maybeSingle()) || null,
    updateDelivery: async (id, fields) => { ok(await c().from('stock_deliveries').update(fields).eq('id', id)); },
    // Paged, so the 1000-row cap never cuts a lot's history short (the lot page and the recall list must see every sale).
    movementsByLots: async (codes) => {
      const out = [];
      for (let from = 0; codes.length; from += 1000) {
        const page = ok(await c().from('stock_movements').select('*').in('lot_code', codes).order('id', { ascending: true }).range(from, from + 999)) || [];
        out.push(...page);
        if (page.length < 1000) break;
      }
      return out;
    },
    // The website packs and undos whose order ID matches `bare` (the query with - / and spaces taken out), found in the database by a
    // case-insensitive regex that allows separators between letters (a[-/ ]*a ...) and looks only before the "@". Paged, capped at 2000 rows.
    // Returns { rows, capped }: capped is true when more than `cap` rows matched, so the caller must not present the answer as complete.
    saleRowsMatching: async (bare, cap = 2000) => {
      const chars = String(bare || '').replace(/[^A-Za-z0-9]/g, '');   // typed text never reaches the pattern except as letters and digits
      if (!chars) return { rows: [], capped: false };
      const pattern = '^[^@]*' + chars.split('').join('[-/ ]*');
      const out = [];
      for (let from = 0; ; from += 1000) {
        const to = Math.min(from + 999, cap);   // one row past the cap tells us it was cut
        const page = ok(await c().from('stock_movements').select('ref,item_slug,lot_code,qty,type').in('type', ['SALE', 'SALE_UNDO']).filter('ref', 'imatch', pattern).order('id', { ascending: true }).range(from, to)) || [];
        out.push(...page);
        if (page.length < to - from + 1 || out.length > cap) break;
      }
      return { rows: out.slice(0, cap), capped: out.length > cap };
    },
    movementsByDelivery: async (id) => ok(await c().from('stock_movements').select('*').eq('delivery_id', id)) || [],
    saveDelivery: async ({ d, lots, moves }) => ok(await c().rpc('stock_save_delivery', { d, lots: lots || [], moves: moves || [] })),
  };
}

let real = null;
const instance = () => real || (real = makeInventory(supabaseStore()));

module.exports = { MAX_QTY, validLot, makeInventory, supabaseStore, StockError, allocate, boxesBySlug, computeSellable, lotContext, committedBoxes, firstShortage, shortText, instance };
