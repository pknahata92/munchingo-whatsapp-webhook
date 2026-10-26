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

class StockError extends Error { constructor(msg, status = 400, extra = {}) { super(msg); this.status = status; this.extra = extra; } }

const TYPES_OUT = { USE: 'Used', DAMAGED: 'Damaged or not okay', SAMPLE: 'Sample or tasting', GIFT: 'Given away', EXHIBITION: 'Taken to an exhibition or event', EVENT_SALE: 'Sold at an exhibition or event', OFFLINE_SALE: 'Sold offline (bulk order or hamper)' };
const NEEDS_WHO = { GIFT: 'Enter who it is going to.', EXHIBITION: 'Enter the event name.', EVENT_SALE: 'Enter the event name.', OFFLINE_SALE: 'Enter who bought it.' };
const MAX_QTY = 100000;
const DUP_WINDOW_MS = 15 * 60_000;
const DAMAGED_ON_RECEIPT = 'Damaged or not okay on receipt';
const HISTORY_TYPES = new Set(['RECEIVE', 'DAMAGED', 'SALE', 'SALE_UNDO', 'USE', 'SAMPLE', 'GIFT', 'EXHIBITION', 'EXHIBITION_RETURN', 'OFFLINE_SALE', 'EVENT_SALE', 'RETURN', 'COUNT_FIX', 'REVERSAL']);
const REVERSE_FREE_MS = 24 * 3_600_000;       // anyone can reverse their own slip within a day; later needs the owner
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
function computeSellable(items, byLotRows, committed) {
  const out = {}; const has = new Set(); const sum = {};
  for (const r of byLotRows) { has.add(r.item_slug); sum[r.item_slug] = (sum[r.item_slug] || 0) + r.qty; }
  for (const i of items) { if (i.kind === 'product' && i.active && has.has(i.slug)) out[i.slug] = (sum[i.slug] || 0) - ((committed || {})[i.slug] || 0); }
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

function makeInventory(store) {
  async function onHandMap() {
    const rows = await store.byLot();   // [{item_slug, lot_code, best_before, qty}]
    const map = {};
    for (const r of rows) { const m = map[r.item_slug] || (map[r.item_slug] = { total: 0, lots: [], any: false }); m.total += r.qty; m.any = true; m.lots.push({ lot_code: r.lot_code, best_before: r.best_before, qty: r.qty }); }
    return map;
  }

  function statusOf(item, m) {
    if (item.manual_low) return 'low';
    if (!m || !m.any) return 'new';
    if (m.total <= 0) return 'out';
    if (item.low_level > 0 && m.total <= item.low_level) return 'low';
    return 'ok';
  }

  async function overview() {
    const [items, map, ev, committed, paused] = await Promise.all([store.items(), onHandMap(), store.events(), store.committed().catch(() => ({})), store.paused().catch(() => [])]);
    const outAt = {}; const events = {};
    for (const e of ev) { const out = e.taken - e.returned; if (out <= 0) continue; outAt[e.item_slug] = (outAt[e.item_slug] || 0) + out; (events[e.ref] = events[e.ref] || []).push({ slug: e.item_slug, taken: e.taken, returned: e.returned, out }); }
    const list = items.filter((i) => i.active).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)).map((i) => {
      const m = map[i.slug];
      const lots = m ? m.lots.filter((l) => l.qty !== 0).sort((a, b) => String(a.best_before || '9').localeCompare(String(b.best_before || '9'))) : [];
      return { slug: i.slug, name: i.name, kind: i.kind, unit: i.unit, low_level: i.low_level, manual_low: !!i.manual_low, on_hand: m ? m.total : 0, committed: committed[i.slug] || 0, sellable: i.kind === 'product' && m && m.any ? m.total - (committed[i.slug] || 0) : null, paused: paused.includes(i.slug), at_events: outAt[i.slug] || 0, counted: !!(m && m.any), status: statusOf(i, m), lots };
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
  const who = (actor) => ({ actor_email: actor && actor.email || null, actor_name: actor && (actor.name || actor.email) || null });

  // Stock arrived: boxes received, how many of them damaged or not okay, lot, best-before, supplier challan, optional billing.
  // `replaces` = id of an earlier receipt this one corrects: the old line (and the damaged line saved with it) is cancelled
  // and the new one written in the same save, so a refused correction changes nothing.
  async function receive({ slug, received, damaged = 0, lot, bestBefore, ref, note, billedKg, amountRupees, confirmDuplicate = false, replaces = null, isOwner = false, actor }) {
    const item = await need(slug);
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
  async function take({ slug, qty, type, note, who: whoFor, invoice, allowNegative = false, actor }) {
    const item = await need(slug);
    if (!TYPES_OUT[type]) throw new StockError('Choose what happened: used, damaged, or sample.');
    const n = int(qty);
    if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) throw new StockError('Enter a whole number, 1 or more.');
    if (type === 'DAMAGED' && !cleanText(note, 300)) throw new StockError('Add a short note on what was wrong.');
    const forWhom = cleanText(whoFor, 80);
    if (NEEDS_WHO[type] && !forWhom) throw new StockError(NEEDS_WHO[type]);
    const have = await onHand(slug);
    if (n > have && !allowNegative) throw new StockError(`Only ${have} ${item.unit} on hand. Count first, or confirm to go below zero.`, 409, { needsConfirm: 'negative', onHand: have });
    const inv = cleanText(invoice, 40);
    if (type === 'OFFLINE_SALE' && !inv) throw new StockError('Enter the invoice number (write PENDING if it is not made yet and fix it later).');
    const base = type === 'OFFLINE_SALE' ? { type, note: cleanText(note, 300) || null, ref: inv, party: forWhom, ...who(actor) } : { type, note: cleanText(note, 300) || null, ref: forWhom || null, ...who(actor) };
    const rows = await outRows(item, n, base);
    await store.insert(rows);
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
      const short = [];
      for (const x of plan) { const have = await onHand(x.item.slug); if (x.qty > have) short.push(`${x.item.name}: need ${x.qty}, have ${have}`); }
      if (short.length) throw new StockError('Not enough on hand: ' + short.join('; ') + '. Count first, or confirm to go below zero.', 409, { needsConfirm: 'negative' });
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
      const short = [];
      for (const x of plan) { const have = await onHand(x.item.slug); if (x.qty > have) short.push(`${x.item.name}: need ${x.qty}, have ${have}`); }
      if (short.length) throw new StockError('Not enough on hand: ' + short.join('; ') + '. Count first, or confirm to go below zero.', 409, { needsConfirm: 'negative' });
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

  // Rows that remove n from stock: split across lots (oldest first) for products; one plain row for packaging.
  async function outRows(item, n, base) {
    const all = await store.byLot();
    const lots = all.filter((r) => r.item_slug === item.slug);
    if (item.kind !== 'product') return [{ ...base, item_slug: item.slug, qty: -n, lot_code: null, best_before: null }];
    const { pieces, short } = allocate(lots, n);
    const rows = pieces.map((p) => ({ ...base, item_slug: item.slug, qty: -p.qty, lot_code: p.lot_code, best_before: p.best_before }));
    if (short > 0) rows.push({ ...base, item_slug: item.slug, qty: -short, lot_code: null, best_before: null });
    return rows;
  }

  // Physical count: type what is on the shelf; the difference is written as one COUNT_FIX line with a note.
  async function count({ slug, counted, note, actor }) {
    const item = await need(slug);
    const c = int(counted);
    if (!Number.isInteger(c) || c < 0 || c > MAX_QTY) throw new StockError('Enter the number you counted (0 or more).');
    const have = await onHand(slug);
    const diff = c - have;
    if (diff === 0) return { onHand: have, diff: 0 };
    const nt = cleanText(note, 300);
    if (!nt) throw new StockError(`The system says ${have}, you counted ${c}. Add a short note on why (breakage, miscount, sample...).`, 400, { diff, onHand: have });
    const base = { type: 'COUNT_FIX', note: nt, ...who(actor) };
    const rows = diff > 0 ? [{ ...base, item_slug: slug, qty: diff, lot_code: null, best_before: null }] : await outRows(item, -diff, base);
    await store.insert(rows);
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
    if (await store.item(slug)) throw new StockError('That item already exists.', 409);
    await store.insertItem({ slug, name: nm, kind, unit: cleanText(unit, 20) || 'pcs', low_level: Math.max(0, int(lowLevel) || 0), sort: 90 });
    return { slug };
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
  // Called after an order is marked Packed. Deducts only from tracking_from onward; oldest lot first; a shortfall becomes a
  // lot-less line so stock shows below zero (a clear signal) instead of the pack failing.
  async function deductForOrder({ orderId, items, at = new Date().toISOString() }) {
    const from = await store.setting('tracking_from');
    if (!from || Date.parse(at) < Date.parse(from)) return { skipped: 'before tracking started' };
    const boxes = boxesBySlug(items); const slugs = Object.keys(boxes);
    if (!slugs.length) return { skipped: 'no tracked items' };
    const known = new Set((await store.items()).filter((i) => i.kind === 'product').map((i) => i.slug));
    const all = await store.byLot(); const ref = `${orderId}@${at}`; const rows = [];
    for (const slug of slugs) {
      if (!known.has(slug)) continue;
      const { pieces, short } = allocate(all.filter((r) => r.item_slug === slug), boxes[slug]);
      pieces.forEach((p) => rows.push({ item_slug: slug, qty: -p.qty, type: 'SALE', lot_code: p.lot_code, best_before: p.best_before, ref }));
      if (short > 0) rows.push({ item_slug: slug, qty: -short, type: 'SALE', lot_code: null, best_before: null, ref });
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

  // { slug: boxes still sellable } for the flavours that have stock recorded (used by utils/stock.js for the automatic sold-out).
  async function sellable() { const [items, rows, committed] = await Promise.all([store.items(), store.byLot(), store.committed()]); return computeSellable(items, rows, committed); }

  return { overview, sellable, receive, receipt, renameLot, take, takeMany, offlineHamper, flow, count, eventReturn, setLow, addItem, setLevel, reverse, history, deductForOrder, restoreForOrder };
}

// ── Real storage (Supabase) ───────────────────────────────────────────────────
function supabaseStore() {
  const c = () => require('./database').client();
  const ok = ({ data, error }) => { if (error) throw new Error(error.code === '42P01' || /does not exist|schema cache/.test(error.message) ? (/party|stock_totals/.test(error.message) ? 'Run stock_offline_migration.sql in Supabase first.' : 'Run stock_ledger_migration.sql in Supabase first.') : (/stock_movements_type_check/.test(error.message) ? 'Run stock_offline_migration.sql in Supabase first.' : error.message)); return data; };
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
    events: async () => ok(await c().from('stock_events').select('*')) || [],
    eventRows: async (ref, slug) => ok(await c().from('stock_movements').select('*').eq('ref', ref).eq('item_slug', slug).in('type', ['EXHIBITION', 'EXHIBITION_RETURN'])) || [],
    salesOf: async (orderId) => ok(await c().from('stock_movements').select('*').like('ref', `${orderId}@%`).in('type', ['SALE', 'SALE_UNDO'])) || [],
  };
}

let real = null;
const instance = () => real || (real = makeInventory(supabaseStore()));

module.exports = { makeInventory, supabaseStore, StockError, allocate, boxesBySlug, computeSellable, committedBoxes, firstShortage, instance };
