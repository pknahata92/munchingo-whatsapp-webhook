'use strict';

/**
 * One Krazy Bakers delivery, every flavour, in one save (spec 6.3, 6.4, 6.10). Lots are created on hold; nothing is sellable until
 * somebody releases them. The whole save is one atomic store call, so a failure leaves nothing behind, and the receipt id
 * makes a resend harmless. Later tasks add release, reject, corrections and lot pages on top of this module.
 */
const { StockError, MAX_QTY, validLot, makeInventory } = require('./inventory');
const REVERSE_FREE_MS = 24 * 3_600_000;   // same day-long window as the ledger's own reverse
const lots = require('./lots');

const PHOTO_PATH = /^\d{4}\/\d{2}\/[0-9a-f]{16}\.jpg$/;
const NAMES = { 'atta-original': 'Atta Original', 'atta-kesari': 'Atta Kesari', 'atta-ajwain': 'Atta Ajwain', 'atta-lite-sugar': 'Atta Sugar-Lite' };
const DEFAULT_RATES = { 'atta-original': 85, 'atta-kesari': 100, 'atta-ajwain': 85, 'atta-lite-sugar': 125 };   // estimate A000244
const FREIGHT_KEYS = ['bus_per_carton', 'delhi_per_carton', 'porter', 'other'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BILL_ONCE = 'stock_deliveries_bill_part_once';
const MAX_RUPEES = 10000000, MAX_FREIGHT = 100000;

const cleanText = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const empty = (v) => v == null || String(v).trim() === '';
const dateWords = (iso) => `${parseInt(iso.slice(8, 10), 10)} ${MONTHS[parseInt(iso.slice(5, 7), 10) - 1]}`;
const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && lots.addDays(v, 0) === v;
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const fail = (msg) => { throw new StockError(msg, 400); };

// A whole-number quantity 0..MAX_QTY; empty gives `dflt`.
function qty(v, label, dflt = null) {
  if (empty(v)) return dflt;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0 || n > MAX_QTY) fail(`${label} must be a whole number from 0 to ${MAX_QTY}.`);
  return n;
}
// Rupees as typed (decimals allowed) between 0 and `max`; empty gives `dflt`.
function rupees(v, label, max, dflt = null) {
  if (empty(v)) return dflt;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0 || n > max) fail(`${label} must be an amount from 0 to ${max}.`);
  return n;
}
const paise = (r) => Math.round(r * 100);
const photo = (p) => { if (typeof p !== 'string' || !PHOTO_PATH.test(p)) fail('That photo did not upload. Take it again.'); return p; };

function makeDeliveries(store, { now = () => Date.now() } = {}) {
  const inventory = () => makeInventory(store, { now });
  const live = (list) => list.filter((d) => d.status !== 'void');   // a corrected (void) delivery frees its bill and part
  const nextPart = (list) => list.reduce((m, d) => Math.max(m, d.part || 1), 0) + 1;
  const clashText = (stored, billNo, part, next) => `Bill ${billNo} part ${part} is already saved (${stored ? dateWords(lots.todayIst(Date.parse(stored.created_at))) : 'earlier'}, ${(stored && (stored.saved_by_name || stored.saved_by_email)) || 'Staff'}). Tap "Add part ${next}" if this is the rest.`;

  async function save(input, { actor, isOwner } = {}) {
    input = input || {};
    const id = String(input.id == null ? '' : input.id);
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) throw new StockError('This form has no receipt number. Reload the page and try again.', 400);
    const stored = await store.delivery(id);
    if (stored) return { ...(stored.result || {}), again: true };

    const settings = lots.readSettings(await store.settingsAll());
    const today = lots.todayIst(now());
    const supplier = cleanText(input.supplier, 80) || 'Krazy Bakers';
    const billNo = cleanText(input.billNo, 40);
    if (!billNo) fail('Enter the bill number.');
    const arrivedOn = empty(input.arrivedOn) ? today : String(input.arrivedOn).trim();
    if (!validDate(arrivedOn)) fail('Enter the date it arrived.');
    if (arrivedOn > today) fail('Arrived on cannot be in the future.');
    const topBake = empty(input.bakeDate) ? null : String(input.bakeDate).trim();
    if (topBake && !validDate(topBake)) fail('Enter the bake date.');
    if (topBake && topBake > arrivedOn) fail('The bake date cannot be after the day it arrived.');

    // bill + part
    const sameBill = live((await store.deliveriesByBill(supplier, billNo)) || []);
    let part;
    if (input.addPart) part = nextPart(sameBill);
    else {
      part = qty(input.part, 'Part', 1) || 1;
      const clash = sameBill.find((d) => (d.part || 1) === part);
      if (clash) throw new StockError(clashText(clash, billNo, part, nextPart(sameBill)), 400);
    }

    // top of the form
    const cartons = qty(input.cartons, 'Cartons', 0);
    const invoiceRupees = rupees(input.invoiceRupees, 'The invoice total', MAX_RUPEES, 0);
    const gstRupees = rupees(input.gstRupees, 'GST on the bill', MAX_RUPEES, 0);
    const billedKg = rupees(input.billedKg, 'Billed kg', 1000000, null);
    const f = input.freight || {};
    const freight = {
      bus_per_carton: rupees(f.busPerCarton, 'Bus fare per carton', MAX_FREIGHT, 0), delhi_per_carton: rupees(f.delhiPerCarton, 'Delhi unloading per carton', MAX_FREIGHT, 0),
      porter: rupees(f.porter, 'Porter', MAX_FREIGHT, 0), other: rupees(f.other, 'Other freight', MAX_FREIGHT, 0),
    };
    const photos = (Array.isArray(input.photos) ? input.photos : []).map(photo);
    const note = cleanText(input.note, 500) || null;
    const supplierBatch = cleanText(input.supplierBatch, 60) || null;

    // rows
    const rows = [];
    for (const r of Array.isArray(input.rows) ? input.rows : []) {
      const slug = r && r.slug;
      if (!NAMES[slug]) fail('Choose one of the four flavours for each row.');
      const name = NAMES[slug];
      if (empty(r.invoiceBoxes) && empty(r.counted) && empty(r.broken)) continue;   // that flavour did not come
      const invoiceBoxes = qty(r.invoiceBoxes, `Invoice boxes for ${name}`, 0);
      const counted = qty(r.counted, `Counted boxes for ${name}`);
      if (counted == null) fail(`Enter how many ${name} boxes you counted (0 if none came).`);
      const broken = qty(r.broken, `Broken boxes for ${name}`, 0);
      if (broken > counted) fail(`Broken boxes cannot be more than the ${counted} counted for ${name}.`);
      let brokenReason = null, brokenPhoto = null;
      if (broken > 0) {
        if (r.brokenReason !== 'transit' && r.brokenReason !== 'supplier') fail('Choose why the boxes broke: on the bus or at the bakery.');
        brokenReason = r.brokenReason;
        if (empty(r.brokenPhoto)) fail(`Take a photo of the broken ${name} boxes.`);
        brokenPhoto = photo(r.brokenPhoto);
      }
      const diffReason = cleanText(r.diffReason, 200);
      if (counted !== invoiceBoxes && !diffReason) fail(`Say why the ${name} count (${counted}) differs from the invoice (${invoiceBoxes}).`);
      const rate = rupees(r.rateRupees, `The rate for ${name}`, MAX_FREIGHT);
      if (rate == null) fail(`Enter the rate per box for ${name}.`);
      const bake = empty(r.bakeDate) ? topBake : String(r.bakeDate).trim();
      if (!bake || !validDate(bake)) fail('Enter the bake date.');
      if (bake > arrivedOn) fail('The bake date cannot be after the day it arrived.');
      rows.push({ slug, name, invoiceBoxes, counted, broken, brokenReason, brokenPhoto, diffReason, rate, bake, good: counted - broken });
    }
    if (!topBake && !rows.length) fail('Enter the bake date.');
    if (!rows.some((r) => r.counted > 0)) fail('Enter at least one flavour with boxes counted.');

    // cost per good box (rates as typed; GST never enters)
    const cost = lots.landedCost({ cartons, freight, lots: rows.map((r, i) => ({ key: i, invoiceBoxes: r.invoiceBoxes, rateRupees: r.rate, good: r.good })) });

    // codes and previous costs
    const [lotRows, ledger] = await Promise.all([store.lots(), store.byLot()]);
    const codes = [...(lotRows || []).flatMap((l) => [l.lot_code, ...(l.aliases || [])]), ...(ledger || []).map((l) => l.lot_code)].filter(Boolean);
    const prevOf = (slug) => {
      let best = null;
      for (const l of lotRows || []) if (l.item_slug === slug && l.unit_cost_paise != null && l.status !== 'void' && (!best || String(l.created_at) >= String(best.created_at))) best = l;
      return best ? Number(best.unit_cost_paise) : null;
    };
    const made = [];
    rows.forEach((r, i) => {
      r.cost = cost[i];
      if (r.counted === 0) return;
      const code = lots.lotCode(r.slug, r.bake, lots.nextSeq(codes, r.slug, r.bake));
      codes.push(code);
      r.code = code; r.dates = lots.datesFor(r.bake, settings); r.prev = prevOf(r.slug);
      made.push(r);
    });

    // warnings
    const warnings = [];
    const add = (key, line) => { const w = warnings.find((x) => x.key === key); if (w) w.text += ' ' + line; else warnings.push({ key, text: line }); };
    for (const r of made) {
      const age = daysBetween(r.bake, arrivedOn);
      if (age > settings.old_bake_days) add('old_bake', `${r.name} was baked on ${dateWords(r.bake)}, so it was ${age} days old when it arrived. The website will stop selling it on ${dateWords(r.dates.websiteStop)}.`);
      if (r.prev != null && r.cost.perGoodPaise != null && r.cost.perGoodPaise > r.prev * 1.1) add('cost_jump', `${r.name} costs Rs ${(r.cost.perGoodPaise / 100).toFixed(2)} a good box, more than 10% above the last lot (Rs ${(r.prev / 100).toFixed(2)}).`);
      if (daysBetween(today, r.dates.websiteStop) <= 14) add('stop_soon', `${r.name} (${r.code}) stops selling on the website on ${dateWords(r.dates.websiteStop)}, ${daysBetween(today, r.dates.websiteStop) < 0 ? 'which has already passed' : 'within 14 days'}.`);
    }
    const lineTotal = rows.reduce((a, r) => a + r.rate * r.invoiceBoxes, 0);
    if (Math.abs((invoiceRupees - gstRupees) - lineTotal) > 1) add('invoice_mismatch', `The invoice total (Rs ${invoiceRupees}${gstRupees ? ', less GST Rs ' + gstRupees : ''}) does not match the boxes times the rates (Rs ${Math.round(lineTotal * 100) / 100}).`);
    const freightTotal = (freight.bus_per_carton + freight.delhi_per_carton) * cartons + freight.porter + freight.other;
    if (freightTotal === 0) add('no_freight', 'No freight entered, so the cost per box will look lower than it really is.');
    const totalCounted = rows.reduce((a, r) => a + r.counted, 0);
    if (totalCounted >= 5000) add('large', `${totalCounted} boxes is a very large delivery. Check the numbers.`);

    const confirm = new Set(Array.isArray(input.confirm) ? input.confirm : []);
    const oldBakeReason = cleanText(input.oldBakeReason, 200);
    if (confirm.has('old_bake') && warnings.some((w) => w.key === 'old_bake') && !oldBakeReason) fail('Add a reason why the bake date is old.');
    const open = warnings.filter((w) => !confirm.has(w.key));
    if (open.length) throw new StockError('Check these before saving', 409, { warnings: open });

    // result, delivery, lots, movements
    const notes = [];
    if (made.some((r) => r.broken > 0 && r.brokenReason === 'transit')) notes.push('Send the bus company a written note of the breakage (claims need notice within 180 days).');
    const result = {
      delivery: { id, billNo, part },
      lots: made.map((r) => ({ code: r.code, slug: r.slug, bakeDate: r.bake, bestBefore: r.dates.bestBefore, lastShip: r.dates.lastShip, websiteStop: r.dates.websiteStop, good: r.good, perGoodPaise: r.cost.perGoodPaise, prevPerGoodPaise: r.prev })),
      toRaise: rows.filter((r) => r.counted !== r.invoiceBoxes).map((r) => ({ slug: r.slug, invoice: r.invoiceBoxes, counted: r.counted })),
      notes,
      warnings: warnings.map((w) => ({ key: w.key, text: w.text })),
    };
    const who = { actor_email: (actor && actor.email) || null, actor_name: (actor && actor.name) || null };
    const moves = [];
    for (const r of made) {
      moves.push({ item_slug: r.slug, qty: r.counted, type: 'RECEIVE', lot_code: r.code, best_before: r.dates.bestBefore, ref: billNo, delivery_id: id, amount_paise: Math.round(r.rate * r.invoiceBoxes * 100), note: oldBakeReason && daysBetween(r.bake, arrivedOn) > settings.old_bake_days ? 'Old bake: ' + oldBakeReason : null, ...who });
      if (r.broken > 0) moves.push({ item_slug: r.slug, qty: -r.broken, type: 'DAMAGED', lot_code: r.code, best_before: r.dates.bestBefore, ref: billNo, delivery_id: id, reason: r.brokenReason, note: `Broken on arrival (${r.brokenReason}). Photo: ${r.brokenPhoto}`, ...who });
    }
    const d = {
      id, supplier, bill_no: billNo, part, bilty: cleanText(input.bilty, 60) || null, arrived_on: arrivedOn, cartons, invoice_paise: paise(invoiceRupees), billed_kg: billedKg,
      gst_paise: paise(gstRupees), freight, photos, note, status: 'received', saved_by_email: who.actor_email, saved_by_name: who.actor_name,
      input: JSON.parse(JSON.stringify(input)), result,
    };
    const lotRowsOut = made.map((r) => ({ item_slug: r.slug, lot_code: r.code, delivery_id: id, supplier_batch: supplierBatch, bake_date: r.bake, best_before: r.dates.bestBefore, status: 'hold', unit_cost_paise: r.cost.perGoodPaise }));
    try {
      const saved = await store.saveDelivery({ d, lots: lotRowsOut, moves });
      if (saved && saved.again) return saved;   // another request with this receipt got in first: its result stands
    } catch (e) {
      if (e && String(e.message).includes(BILL_ONCE)) {
        const first = await store.delivery(id);
        if (first) return { ...(first.result || {}), again: true };
        const list = live((await store.deliveriesByBill(supplier, billNo)) || []);
        throw new StockError(clashText(list.find((x) => (x.part || 1) === part), billNo, part, nextPart(list)), 400);
      }
      throw e;
    }
    return result;
  }

  async function lastPrefill() {
    const last = await store.lastDelivery();
    const rates = { ...DEFAULT_RATES };
    const rows = last && last.input && Array.isArray(last.input.rows) ? last.input.rows : [];
    for (const r of rows) if (r && DEFAULT_RATES[r.slug] != null && !empty(r.rateRupees) && Number.isFinite(Number(r.rateRupees))) rates[r.slug] = Number(r.rateRupees);
    const lf = (last && last.freight) || {};
    const freight = {};
    for (const [k, camel] of [['bus_per_carton', 'busPerCarton'], ['delhi_per_carton', 'delhiPerCarton'], ['porter', 'porter'], ['other', 'other']]) freight[camel] = Number.isFinite(Number(lf[k])) ? Number(lf[k]) : 0;
    return { rates, freight };
  }

  // ---- Release, Reject, Hold (spec 6.5) ----
  const OWNER_ONLY = 'Only the owner can reject or hold a lot.';
  const nameOf = async (slug) => { const it = await store.item(slug).catch(() => null); return (it && it.name) || NAMES[slug] || slug; };
  const onHandOf = (ledger, slug, code) => (ledger || []).filter((r) => r.item_slug === slug && r.lot_code === code).reduce((a, r) => a + r.qty, 0);

  // A lot is addressed by code (or alias) plus, when the code is shared, the flavour (R5). A lot received through the old form after
  // the migration has ledger rows but no stock_lots row: it is created as released first. Tasks 7-9 reuse this.
  async function findLot({ code, slug } = {}) {
    const c = cleanText(code, 60);
    if (!c) throw new StockError('No lot with that code.', 404);
    const rows = ((await store.lotsByCode(c)) || []).filter((l) => !slug || l.item_slug === slug);
    const ledger = (await store.byLot()) || [];
    const have = new Set(((await store.lots()) || []).map((l) => `${l.item_slug}|${l.lot_code}`));
    const only = new Map();   // ledger-only candidates, keyed by flavour
    for (const r of ledger) {
      if (r.lot_code !== c || (slug && r.item_slug !== slug) || have.has(`${r.item_slug}|${r.lot_code}`) || rows.some((l) => l.item_slug === r.item_slug)) continue;   // ledger rows under an old code (now an alias) belong to the lot that has it
      const e = only.get(r.item_slug) || { slug: r.item_slug, bestBefore: null };
      if (r.best_before && (!e.bestBefore || r.best_before < e.bestBefore)) e.bestBefore = r.best_before;
      only.set(r.item_slug, e);
    }
    const found = [...rows.map((l) => ({ slug: l.item_slug, lot: l })), ...[...only.values()].map((e) => ({ slug: e.slug, made: e }))];
    if (!found.length) throw new StockError('No lot with that code.', 404);
    if (found.length > 1) throw new StockError('This code is on more than one flavour. Choose one.', 409, { choose: await Promise.all(found.map(async (f) => ({ code: c, slug: f.slug, name: await nameOf(f.slug) }))) });
    const f = found[0];
    if (f.lot) return f.lot;
    const parsed = lots.parseCode(c);
    await store.insertLots([{ item_slug: f.slug, lot_code: c, bake_date: parsed ? parsed.bakeDate : null, best_before: f.made.bestBefore, status: 'released' }]);
    return ((await store.lotsByCode(c)) || []).find((l) => l.item_slug === f.slug && l.lot_code === c);
  }

  const ownerOnly = (isOwner) => { if (!isOwner) throw new StockError(OWNER_ONLY, 403); };
  const reasonOf = (v) => { const r = cleanText(v, 300); if (!r) fail('Add a reason.'); return r; };

  async function release(input, { actor, isOwner } = {}) {
    input = input || {};
    const lot = await findLot(input);
    if (lot.status === 'released') fail('This lot is already released.');
    if (lot.status === 'rejected' || lot.status === 'void') fail('This lot was rejected or corrected, so it cannot be released.');
    if (input.tasted !== true) fail('Tick that you tasted one box and it is OK.');
    const w = typeof input.weightG === 'number' ? input.weightG : (empty(input.weightG) ? NaN : Number(String(input.weightG).trim()));
    if (!Number.isInteger(w) || w < 100 || w > 1000) fail('Enter the weight of one box in grams.');
    const warnings = [];
    if (w < 250) warnings.push(`One box weighed ${w} g, under the 250 g on the pack. Weigh a second box.`);

    // Packaging is a hand-kept list (Prashant, 8 Nov 2026): Release takes nothing off it.
    const fields = { status: 'released', released_at: new Date(now()).toISOString(), released_by: (actor && actor.email) || null, check_weight_g: w, check_note: cleanText(input.note, 300) || null };
    await store.updateLot(lot.item_slug, lot.lot_code, fields);
    return { lot: { ...lot, ...fields }, warnings };
  }

  async function reject(input, { actor, isOwner } = {}) {
    ownerOnly(isOwner);
    input = input || {};
    const lot = await findLot(input);
    if (lot.status === 'released') fail('Only a lot still on hold can be rejected. Use Hold this lot.');
    if (lot.status !== 'hold') fail('This lot was already rejected or corrected.');
    if (lot.released_at) fail('This lot was released before, so it cannot be rejected.');
    const reason = reasonOf(input.reason);
    const onHand = onHandOf((await store.byLot()) || [], lot.item_slug, lot.lot_code);
    if (onHand !== 0) {
      const d = lot.delivery_id ? await store.delivery(lot.delivery_id) : null;
      await store.insert([{ item_slug: lot.item_slug, qty: -onHand, type: 'SUPPLIER_RETURN', lot_code: lot.lot_code, best_before: lot.best_before || null, ref: (d && d.bill_no) || null, note: `Rejected: ${reason}`, actor_email: (actor && actor.email) || null, actor_name: (actor && (actor.name || actor.email)) || null }]);
    }
    await store.updateLot(lot.item_slug, lot.lot_code, { status: 'rejected', reject_reason: reason });
    return { lot: { ...lot, status: 'rejected', reject_reason: reason } };
  }

  async function hold(input, { actor, isOwner } = {}) {
    ownerOnly(isOwner);
    input = input || {};
    const lot = await findLot(input);
    if (lot.status !== 'released') fail('Only a released lot can be put on hold.');
    const reason = reasonOf(input.reason);
    await store.updateLot(lot.item_slug, lot.lot_code, { status: 'hold', hold_reason: reason });
    return { lot: { ...lot, status: 'hold', hold_reason: reason } };
  }

  // ---- Broken while cartoning, Throw away expired (spec 6.6) ----
  async function brokenWhileCartoning(input, { actor } = {}) {
    input = input || {};
    const lot = await findLot(input);
    const n = qty(input.qty, 'The number of boxes');
    if (!n) fail('Enter how many boxes broke.');
    const p = empty(input.photo) ? null : photo(input.photo);
    const text = cleanText(input.note, 200);
    const note = 'Broken while cartoning' + (text ? ': ' + text : '') + (p ? '. Photo: ' + p : '');
    const have = onHandOf((await store.byLot()) || [], lot.item_slug, lot.lot_code);
    if (n > have) throw new StockError(`Lot ${lot.lot_code} has only ${Math.max(0, have)} boxes.`, 409);
    return inventory().take({ slug: lot.item_slug, qty: n, type: 'DAMAGED', lot: lot.lot_code, reason: 'repack', note, actor });
  }

  async function throwExpired(input, { actor, isOwner } = {}) {
    if (!isOwner) throw new StockError('Only the owner can throw away expired stock.', 403);
    input = input || {};
    const today = lots.todayIst(now());
    const [ledger, lotRows] = await Promise.all([store.byLot(), store.lots()]);
    const meta = new Map((lotRows || []).map((l) => [`${l.item_slug}|${l.lot_code}`, l]));
    const groups = new Map();
    for (const r of ledger || []) {
      if (r.lot_code == null || (input.slug && r.item_slug !== input.slug)) continue;
      const k = `${r.item_slug}|${r.lot_code}`;
      const g = groups.get(k) || { slug: r.item_slug, code: r.lot_code, qty: 0, bb: null };
      g.qty += r.qty;
      if (r.best_before && (!g.bb || r.best_before < g.bb)) g.bb = r.best_before;
      groups.set(k, g);
    }
    const out = [], rows = [];
    const who = { actor_email: (actor && actor.email) || null, actor_name: (actor && (actor.name || actor.email)) || null };
    for (const g of groups.values()) {
      const m = meta.get(`${g.slug}|${g.code}`);
      const bb = (m && m.best_before) || g.bb;
      if (!bb || !(today > bb) || !(g.qty > 0)) continue;
      rows.push({ item_slug: g.slug, qty: -g.qty, type: 'EXPIRED', lot_code: g.code, best_before: bb, note: 'Thrown away after best before', ...who });
      out.push({ code: g.code, slug: g.slug, qty: g.qty });
    }
    if (rows.length) await store.insert(rows);
    return { lines: out };
  }

  // ---- Corrections (spec 6.7) ----
  // Correct whole delivery: only while every lot is still on hold (never released) and nothing but the delivery's own rows is on them.
  // One REVERSAL per row not yet reversed (a retry after a partial failure skips the ones already done), then the lots, then the delivery
  // go void. The form reopens from the stored input.
  async function correctDelivery(input, { actor, isOwner } = {}) {
    input = input || {};
    const reason = reasonOf(input.reason);
    const d = await store.delivery(String(input.id == null ? '' : input.id));
    if (!d) throw new StockError('No such delivery.', 404);
    if (d.status === 'void') throw new StockError('This delivery was already corrected.', 409);
    const email = String((actor && actor.email) || '').toLowerCase();
    if (!isOwner) {
      if (now() - Date.parse(d.created_at) > REVERSE_FREE_MS) throw new StockError('Only the owner can correct a delivery older than a day.', 403);
      if (!email || email !== String(d.saved_by_email || '').toLowerCase()) throw new StockError('Only the person who saved this delivery, or the owner, can correct it.', 403);
    }
    const mine = ((await store.lots()) || []).filter((l) => l.delivery_id === d.id);
    if (mine.some((l) => l.status === 'released' || l.released_at)) throw new StockError('Released lots cannot be corrected here. Use Fix lot.', 409);
    const USED = 'Boxes from this delivery have already been used. Correct it with Fix lot or a count instead.';
    if (mine.some((l) => l.status !== 'hold' && l.status !== 'void')) throw new StockError(USED, 409);
    const own = (await store.movementsByDelivery(d.id)) || [];
    const ownIds = new Set(own.map((m) => m.id));
    const pairs = new Set(mine.map((l) => `${l.item_slug}|${l.lot_code}`));
    const onLots = ((await store.movementsByLots([...new Set(mine.map((l) => l.lot_code))])) || []).filter((m) => pairs.has(`${m.item_slug}|${m.lot_code}`));
    if (onLots.some((m) => !ownIds.has(m.id) && !(m.reverses_id && ownIds.has(m.reverses_id)))) throw new StockError(USED, 409);

    const rows = own.filter((m) => m.type !== 'REVERSAL' && !m.reverses_id);
    const done = new Set((await store.reversedAmong(rows.map((m) => m.id))) || []);
    const who = { actor_email: (actor && actor.email) || null, actor_name: (actor && (actor.name || actor.email)) || null };
    const reversals = rows.filter((m) => !done.has(m.id)).map((m) => ({ item_slug: m.item_slug, qty: -m.qty, type: 'REVERSAL', lot_code: m.lot_code, best_before: m.best_before, ref: m.ref, note: reason, reverses_id: m.id, delivery_id: d.id, ...who }));
    if (reversals.length) await store.insert(reversals);
    for (const l of mine) if (l.status !== 'void') await store.updateLot(l.item_slug, l.lot_code, { status: 'void' });
    await store.updateDelivery(d.id, { status: 'void' });
    const prefill = JSON.parse(JSON.stringify(d.input || {}));
    delete prefill.id;
    return { prefill };
  }

  // Fix lot (owner): change a lot's code and/or bake date after the fact. Remaining stock moves with COUNT_FIX pairs (as renameLot
  // does), the old code stays as an alias, and nothing in the ledger is edited.
  async function fixLot(input, { actor, isOwner } = {}) {
    if (!isOwner) throw new StockError('Only the owner can fix a lot.', 403);
    input = input || {};
    const lot = await findLot(input);
    const newCodeIn = cleanText(input.newCode, 60), newBakeIn = empty(input.newBakeDate) ? null : String(input.newBakeDate).trim();
    if (!newCodeIn && !newBakeIn) fail('Enter the new code or the new bake date.');
    const settings = lots.readSettings(await store.settingsAll());
    const oldCode = lot.lot_code, slug = lot.item_slug;
    if (newBakeIn) {
      if (!validDate(newBakeIn)) fail('Enter the new bake date as a real date.');
      if (newBakeIn > lots.todayIst(now())) fail('The bake date cannot be in the future.');
    }
    const [lotRows, ledger] = await Promise.all([store.lots(), store.byLot()]);
    let newCode = newCodeIn, bake = lot.bake_date ? String(lot.bake_date).slice(0, 10) : null, bestBefore = lot.best_before ? String(lot.best_before).slice(0, 10) : null, datesChange = false;
    if (newCode) {
      if (!validLot(newCode)) fail('The lot can use letters, numbers, space and . - / only.');
      if (newCode === oldCode) fail('The new lot code must be different from the old one.');
      const p = lots.parseCode(newCode);
      if (p && p.slug !== slug) fail('That code is for a different flavour.');
      if (p && !newBakeIn) { bake = p.bakeDate; datesChange = true; }
      if (p && newBakeIn && p.bakeDate !== newBakeIn) fail('The new code and the new bake date do not match.');
    }
    if (newBakeIn) {
      if (newBakeIn === bake && !newCode) fail('The new bake date is the same as the current one.');
      bake = newBakeIn; datesChange = true;
    }
    const ownCodes = new Set([oldCode, ...(lot.aliases || [])]);
    if (!newCode) {
      const codes = [...(lotRows || []).flatMap((l) => [l.lot_code, ...(l.aliases || [])]), ...(ledger || []).map((l) => l.lot_code)].filter(Boolean);
      newCode = lots.lotCode(slug, bake, lots.nextSeq(codes, slug, bake));
    }
    const usedElsewhere = (lotRows || []).some((l) => l.item_slug === slug && l.lot_code !== oldCode && (l.lot_code === newCode || (l.aliases || []).includes(newCode)))
      || (!ownCodes.has(newCode) && (ledger || []).some((r) => r.item_slug === slug && r.lot_code === newCode));
    if (usedElsewhere) fail('That code is already used by another lot.');
    if (datesChange) bestBefore = lots.datesFor(bake, settings).bestBefore;

    const note = `Lot fixed ${oldCode} to ${newCode}`;
    const who = { actor_email: (actor && actor.email) || null, actor_name: (actor && (actor.name || actor.email)) || null };
    const rows = [];
    for (const g of (ledger || []).filter((r) => r.item_slug === slug && r.lot_code === oldCode && r.qty !== 0)) {
      const to = datesChange ? bestBefore : (g.best_before || null);
      rows.push({ item_slug: slug, type: 'COUNT_FIX', qty: -g.qty, lot_code: oldCode, best_before: g.best_before || null, note, ...who },
        { item_slug: slug, type: 'COUNT_FIX', qty: g.qty, lot_code: newCode, best_before: to, note, ...who });
    }
    if (rows.length) await store.insert(rows);
    const aliases = [...new Set([...(lot.aliases || []).filter((a) => a !== newCode), oldCode])];
    await store.updateLot(slug, oldCode, { lot_code: newCode, bake_date: bake, best_before: bestBefore, aliases });
    return { from: oldCode, to: newCode, warning: 'Stickers already printed carry the old code or date: reprint them.' };
  }

  return { save, lastPrefill, findLot, release, reject, hold, brokenWhileCartoning, throwExpired, correctDelivery, fixLot };
}

let real = null;
const instance = () => real || (real = makeDeliveries(require('./inventory').supabaseStore()));

module.exports = { makeDeliveries, instance, PHOTO_PATH };
