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
// Freight before the first delivery is saved (8 Nov 2026 facts): Delhi unloading Rs 20 a carton, porter Rs 2,000 a trip, bus fare per
// carton not known yet. The last delivery's own freight always wins over these.
const DEFAULT_FREIGHT = { busPerCarton: 0, delhiPerCarton: 20, porter: 2000, other: 0 };
const FREIGHT_KEYS = ['bus_per_carton', 'delhi_per_carton', 'porter', 'other'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BILL_ONCE = 'stock_deliveries_bill_part_once';
const MAX_RUPEES = 10000000, MAX_FREIGHT = 100000;

const cleanText = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const empty = (v) => v == null || String(v).trim() === '';
// Rupees with Indian digit grouping (1,15,000), no locale data. Whole amounts have no decimals; paise (or `two`) show 2 decimals.
const inr = (n, two) => {
  const neg = n < 0, fixed = Math.abs(n).toFixed(2), [i, d] = fixed.split('.');
  const head = i.length > 3 ? i.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ',') + ',' + i.slice(-3) : i;
  return (neg ? '-' : '') + head + (two || d !== '00' ? '.' + d : '');
};
const listWords = (a) => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
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

function makeDeliveries(store, { now = () => Date.now(), db = null, mailer = null } = {}) {
  const getMailer = () => mailer || require('./mailer');
  const ADMIN_URL = 'https://admin.munchingo.com/admin';
  // An owner email never changes what the user did and never holds the request up: it is sent in the background, a failure is
  // logged and swallowed, and the in-flight sends are kept so tests can wait for them (mailSettled).
  const inflight = new Set();
  const notify = (fn, args) => {
    const p = (async () => { try { await getMailer()[fn](args); } catch (e) { console.error(`[MAIL] ${fn} failed: ${e && e.message}`); } })();
    inflight.add(p); p.then(() => inflight.delete(p));
  };
  const mailSettled = () => Promise.allSettled([...inflight]);
  const getDb = () => db || require('./database');
  const inventory = () => makeInventory(store, { now });
  const live = (list) => list.filter((d) => d.status !== 'void');   // a corrected (void) delivery frees its bill and part
  const nextPart = (list) => list.reduce((m, d) => Math.max(m, d.part || 1), 0) + 1;
  const clashText = (stored, billNo, part, next) => `Bill ${billNo} part ${part} is already saved (${stored ? dateWords(lots.todayIst(Date.parse(stored.created_at))) : 'earlier'}, ${(stored && (stored.saved_by_name || stored.saved_by_email)) || 'Staff'}). Tap "Add part ${next}" if this is the rest.`;

  // `preview`: the review screen before Save. Every check runs and the codes, dates, costs and warnings come back exactly as a save
  // would make them, but nothing is written and no warning needs confirming. A receipt already saved answers its stored result.
  async function save(input, { actor, isOwner, preview = false } = {}) {
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
    const oldBake = new Map();   // one sentence per distinct bake date
    for (const r of made) { const age = daysBetween(r.bake, arrivedOn); if (age <= settings.old_bake_days) continue; const g = oldBake.get(r.bake) || oldBake.set(r.bake, { age, names: [], stop: r.dates.websiteStop }).get(r.bake); if (!g.names.includes(r.name)) g.names.push(r.name); }
    for (const [bake, g] of oldBake) { const one = g.names.length === 1; add('old_bake', `${listWords(g.names)} ${one ? 'was' : 'were'} baked on ${dateWords(bake)}, ${g.age} days before ${one ? 'it' : 'they'} arrived. The website will stop selling ${one ? 'it' : 'them'} on ${dateWords(g.stop)}.`); }
    for (const r of made) {
      if (r.prev != null && r.cost.perGoodPaise != null && r.cost.perGoodPaise > r.prev * 1.1) add('cost_jump', `${r.name} costs Rs ${inr(r.cost.perGoodPaise / 100, true)} a good box, more than 10% above the last lot (Rs ${inr(r.prev / 100, true)}).`);
      if (daysBetween(today, r.dates.websiteStop) <= 14) add('stop_soon', `${r.name} (${r.code}) stops selling on the website on ${dateWords(r.dates.websiteStop)}, ${daysBetween(today, r.dates.websiteStop) < 0 ? 'which has already passed' : 'within 14 days'}.`);
    }
    const lineTotal = rows.reduce((a, r) => a + r.rate * r.invoiceBoxes, 0);
    if (Math.abs((invoiceRupees - gstRupees) - lineTotal) > 1) add('invoice_mismatch', `The invoice total (Rs ${inr(invoiceRupees)}${gstRupees ? ', less GST Rs ' + inr(gstRupees) : ''}) does not match the boxes times the rates (Rs ${inr(Math.round(lineTotal * 100) / 100)}).`);
    const freightTotal = (freight.bus_per_carton + freight.delhi_per_carton) * cartons + freight.porter + freight.other;
    if (freightTotal === 0) add('no_freight', 'No freight entered, so the cost per box will look lower than it really is.');
    const totalCounted = rows.reduce((a, r) => a + r.counted, 0);
    if (totalCounted >= 5000) add('large', `${totalCounted} boxes is a very large delivery. Check the numbers.`);
    const notes = [];
    if (made.some((r) => r.broken > 0 && r.brokenReason === 'transit')) notes.push('Send the bus company a written note of the breakage (claims need notice within 180 days).');
    const result = {
      delivery: { id, billNo, part },
      lots: made.map((r) => ({ code: r.code, slug: r.slug, bakeDate: r.bake, bestBefore: r.dates.bestBefore, lastShip: r.dates.lastShip, websiteStop: r.dates.websiteStop, good: r.good, perGoodPaise: r.cost.perGoodPaise, prevPerGoodPaise: r.prev })),
      toRaise: rows.filter((r) => r.counted !== r.invoiceBoxes).map((r) => ({ slug: r.slug, invoice: r.invoiceBoxes, counted: r.counted })),
      notes,
      warnings: warnings.map((w) => ({ key: w.key, text: w.text })),
    };
    if (preview) return { preview: true, ...result };

    const confirm = new Set(Array.isArray(input.confirm) ? input.confirm : []);
    const oldBakeReason = cleanText(input.oldBakeReason, 200);
    if (confirm.has('old_bake') && warnings.some((w) => w.key === 'old_bake') && !oldBakeReason) fail('Add a reason why the bake date is old.');
    const open = warnings.filter((w) => !confirm.has(w.key));
    if (open.length) throw new StockError('Check these before saving', 409, { warnings: open });

    // delivery, lots, movements
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
    notify('sendDeliveryEmail', {
      delivery: result.delivery,
      lots: result.lots.map((l) => ({ code: l.code, name: NAMES[l.slug] || l.slug, good: l.good, cost: l.perGoodPaise == null ? '' : 'Rs ' + inr(l.perGoodPaise / 100, true) })),
      warnings: result.warnings, toRaise: result.toRaise.map((x) => ({ ...x, name: NAMES[x.slug] || x.slug })),
      url: `${ADMIN_URL}#delivery=${encodeURIComponent(id)}`,
    });
    return result;
  }

  async function lastPrefill() {
    const last = await store.lastDelivery();
    const rates = { ...DEFAULT_RATES };
    const rows = last && last.input && Array.isArray(last.input.rows) ? last.input.rows : [];
    for (const r of rows) if (r && DEFAULT_RATES[r.slug] != null && !empty(r.rateRupees) && Number.isFinite(Number(r.rateRupees))) rates[r.slug] = Number(r.rateRupees);
    if (!last) return { rates, freight: { ...DEFAULT_FREIGHT } };
    const lf = last.freight || {};
    const freight = {};
    for (const [k, camel] of [['bus_per_carton', 'busPerCarton'], ['delhi_per_carton', 'delhiPerCarton'], ['porter', 'porter'], ['other', 'other']]) freight[camel] = Number.isFinite(Number(lf[k])) ? Number(lf[k]) : 0;
    return { rates, freight };
  }

  // ---- Release, Reject, Hold (spec 6.5) ----
  const OWNER_ONLY = 'Only the owner can reject or hold a lot.';
  const nameOf = async (slug) => { const it = await store.item(slug).catch(() => null); return (it && it.name) || NAMES[slug] || slug; };
  const onHandOf = (ledger, slug, code) => (ledger || []).filter((r) => r.item_slug === slug && r.lot_code === code).reduce((a, r) => a + r.qty, 0);

  // A lot is addressed by code (or alias) plus, when the code is shared, the flavour (R5). Within one flavour the code is resolved as
  // everywhere else (final review C1, lots.resolveCode): exact own code, then own code ignoring case, then an alias, so one flavour never
  // answers twice. A lot received through the old form after the migration has ledger rows but no stock_lots row: it is created as
  // released first. Tasks 7-9 reuse this.
  async function findLot({ code, slug } = {}) {
    const c = cleanText(code, 60);
    if (!c) throw new StockError('No lot with that code.', 404);
    const { cand } = await pick(c, slug);
    if (cand.row) return cand.row;
    const parsed = lots.parseCode(cand.code);
    const bb = ((await store.byLot()) || []).filter((r) => r.item_slug === cand.slug && r.lot_code === cand.code && r.best_before).map((r) => day(r.best_before)).sort()[0] || null;
    await store.insertLots([{ item_slug: cand.slug, lot_code: cand.code, bake_date: parsed ? parsed.bakeDate : null, best_before: bb, status: 'released' }]);
    return ((await store.lots()) || []).find((l) => l.item_slug === cand.slug && l.lot_code === cand.code);
  }

  const ownerOnly = (isOwner) => { if (!isOwner) throw new StockError(OWNER_ONLY, 403); };
  const reasonOf = (v) => { const r = cleanText(v, 300); if (!r) fail('Add a reason.'); return r; };

  async function release(input, { actor, isOwner } = {}) {
    input = input || {};
    const lot = await findLot(input);
    if (lot.status === 'released') fail('This lot is already released.');
    if (lot.status === 'rejected' || lot.status === 'void') fail('This lot was rejected or corrected, so it cannot be released.');
    // Final review I2: staff release a new delivery (never released); a lot the owner put on hold after release (a recall, a complaint)
    // waits for the owner.
    if (!isOwner && lots.ownerHold(lot)) throw new StockError('This lot was put on hold by the owner. Only the owner can release it.', 403);
    if (input.tasted !== true) fail('Tick that you tasted one box and it is OK.');
    const w = typeof input.weightG === 'number' ? input.weightG : (empty(input.weightG) ? NaN : Number(String(input.weightG).trim()));
    if (!Number.isInteger(w) || w < 100 || w > 1000) fail('Enter the weight of one box in grams.');
    const warnings = [];
    if (w < 250) warnings.push(`One box weighed ${w} g, under the 250 g on the pack. Weigh a second box.`);

    // Packaging is a hand-kept list (Prashant, 8 Nov 2026): Release takes nothing off it.
    const fields = { status: 'released', released_at: new Date(now()).toISOString(), released_by: (actor && actor.email) || null, check_weight_g: w, check_note: cleanText(input.note, 300) || null };
    await store.updateLot(lot.item_slug, lot.lot_code, fields);
    if (!isOwner) {
      let name = NAMES[lot.item_slug] || lot.item_slug;
      try { const items = (await store.items()) || []; const it = items.find((i) => i.slug === lot.item_slug); if (it && it.name) name = it.name; } catch (e) { /* the built-in name stands */ }
      notify('sendLotReleasedEmail', { code: lot.lot_code, name, by: (actor && (actor.name || actor.email)) || 'Staff', weightG: w, note: fields.check_note, url: `${ADMIN_URL}#lot=${encodeURIComponent(lot.lot_code)}&slug=${encodeURIComponent(lot.item_slug)}` });
    }
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
    const meta = lots.lotIndex(lotRows || []);   // an alias row takes its lot's best before (C2)
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
    const block = await correctBlock(d, actor, isOwner);
    if (block) throw new StockError(block.message, block.status);
    const mine = ((await store.lots()) || []).filter((l) => l.delivery_id === d.id);
    const own = (await store.movementsByDelivery(d.id)) || [];
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

  // Why this actor cannot correct this delivery now (the Task 8 rules), or null when they can. Reads only; correctDelivery and the
  // delivery page (canCorrect) share it so the button and the refusal always agree.
  async function correctBlock(d, actor, isOwner) {
    if (d.status === 'void') return { message: 'This delivery was already corrected.', status: 409 };
    const email = String((actor && actor.email) || '').toLowerCase();
    if (!isOwner) {
      if (now() - Date.parse(d.created_at) > REVERSE_FREE_MS) return { message: 'Only the owner can correct a delivery older than a day.', status: 403 };
      if (!email || email !== String(d.saved_by_email || '').toLowerCase()) return { message: 'Only the person who saved this delivery, or the owner, can correct it.', status: 403 };
    }
    const mine = ((await store.lots()) || []).filter((l) => l.delivery_id === d.id);
    if (mine.some((l) => l.status === 'released' || l.released_at)) return { message: 'Released lots cannot be corrected here. Use Fix lot.', status: 409 };
    const USED = { message: 'Boxes from this delivery have already been used. Correct it with Fix lot or a count instead.', status: 409 };
    if (mine.some((l) => l.status !== 'hold' && l.status !== 'void')) return USED;
    const own = (await store.movementsByDelivery(d.id)) || [];
    const ownIds = new Set(own.map((m) => m.id));
    const pairs = new Set(mine.map((l) => `${l.item_slug}|${l.lot_code}`));
    const onLots = ((await store.movementsByLots([...new Set(mine.map((l) => l.lot_code))])) || []).filter((m) => pairs.has(`${m.item_slug}|${m.lot_code}`));
    if (onLots.some((m) => !ownIds.has(m.id) && !(m.reverses_id && ownIds.has(m.reverses_id)))) return USED;
    return null;
  }

  // The delivery page (read only): the saved bill, its lots as they are now, what to raise with the supplier, and whether this actor may
  // still use Correct whole delivery.
  async function deliveryPage(id, { actor, isOwner } = {}) {
    const d = await store.delivery(String(id == null ? '' : id));
    if (!d) throw new StockError('No such delivery.', 404);
    const [lotRows, ledger, raw] = await Promise.all([store.lots(), store.byLot(), store.settingsAll()]);
    const s = lots.readSettings(raw), stored = (d.result && d.result.lots) || [];
    const out = [];
    for (const l of (lotRows || []).filter((x) => x.delivery_id === d.id)) {
      // its own line of the saved result: by code (or an older code it was fixed from), else the flavour's (two lots of one flavour differ)
      const was = stored.find((x) => x.slug === l.item_slug && (x.code === l.lot_code || (l.aliases || []).includes(x.code))) || stored.find((x) => x.slug === l.item_slug) || {};
      const bb = l.best_before ? String(l.best_before).slice(0, 10) : null, cut = bb ? lots.cutoffs(bb, s) : null;
      out.push({ code: l.lot_code, slug: l.item_slug, name: await nameOf(l.item_slug), status: l.status, ownerHold: lots.ownerHold(l), good: was.good != null ? was.good : null, onHand: onHandOf(ledger, l.item_slug, l.lot_code),
        bakeDate: l.bake_date ? String(l.bake_date).slice(0, 10) : null, bestBefore: bb, websiteStop: cut ? cut.websiteStop : null, lastShip: cut ? cut.lastShip : null,
        perGoodPaise: l.unit_cost_paise != null ? Number(l.unit_cost_paise) : (was.perGoodPaise != null ? was.perGoodPaise : null) });
    }
    const res = d.result || {};
    return {
      delivery: { id: d.id, billNo: d.bill_no, part: d.part, supplier: d.supplier, arrivedOn: d.arrived_on ? String(d.arrived_on).slice(0, 10) : null, cartons: d.cartons, photos: Array.isArray(d.photos) ? d.photos : [], note: d.note || null, status: d.status, savedBy: d.saved_by_name || d.saved_by_email || null, savedAt: d.created_at || null },
      lots: out, toRaise: res.toRaise || [], notes: res.notes || [], canCorrect: !(await correctBlock(d, actor, isOwner)),
    };
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
    // A retry after a failed row update: the COUNT_FIX pair for this very fix is already in the ledger under the target code. That
    // code is this lot's own, not another lot's, and it is not a taken sequence number.
    const ledgerHas = (c) => (ledger || []).some((r) => r.item_slug === slug && r.lot_code === c);
    const heldByRow = (c) => (lotRows || []).some((l) => l.item_slug === slug && (l.lot_code === c || (l.aliases || []).includes(c)));
    const ours = async (c) => ledgerHas(c) && !heldByRow(c) && ((await store.movementsByLots([c])) || []).some((m) => m.item_slug === slug && m.type === 'COUNT_FIX' && m.note === `Lot fixed ${oldCode} to ${c}`);
    if (!newCode) {
      const codes = [...(lotRows || []).flatMap((l) => [l.lot_code, ...(l.aliases || [])]), ...(ledger || []).map((l) => l.lot_code)].filter(Boolean);
      const seq = lots.nextSeq(codes, slug, bake);
      const last = seq > 1 ? lots.lotCode(slug, bake, seq - 1) : null;
      newCode = last && await ours(last) ? last : lots.lotCode(slug, bake, seq);
    }
    const pending = await ours(newCode);
    const usedElsewhere = (lotRows || []).some((l) => l.item_slug === slug && l.lot_code !== oldCode && (l.lot_code === newCode || (l.aliases || []).includes(newCode)))
      || (!ownCodes.has(newCode) && !pending && ledgerHas(newCode));
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

  // ---- Lots list, lot page, trace search, recall CSV (spec 6.8). Everything here only reads. ----
  const up = (v) => String(v == null ? '' : v).trim().toUpperCase();
  const day = (v) => (v ? String(v).slice(0, 10) : null);
  const ORDER_ID = /^MNG-[A-Z0-9]{4}-\d{4}$/;
  const saleKey = (r) => `${r.ref}|${r.item_slug}|${r.lot_code || ''}`;   // the same match restoreForOrder uses to undo a pack
  const orderOfRef = (ref) => { const s = String(ref || ''), i = s.indexOf('@'); return { orderId: i >= 0 ? s.slice(0, i) : s, at: i >= 0 ? s.slice(i + 1) : null }; };

  async function world() {
    const [lotRows, ledger, items, raw] = await Promise.all([store.lots(), store.byLot(), store.items(), store.settingsAll()]);
    const products = new Map((items || []).filter((i) => i.kind === 'product').map((i) => [i.slug, i.name || NAMES[i.slug] || i.slug]));
    const mine = (lotRows || []).filter((l) => products.has(l.item_slug));
    return { lotRows: mine, index: lots.lotIndex(mine), ledger: (ledger || []).filter((r) => products.has(r.item_slug)), products, s: lots.readSettings(raw) };
  }
  // A lot's codes: its own and the aliases that are its (an alias another lot of the flavour owns as its own code is that lot's, C1).
  const codesOf = (w, l) => lots.codesOfLot(w.index, l);

  // The lots a typed code can mean, one per flavour at most (final review C1, lots.resolveCode). A code only in the ledger is a legacy lot.
  const candidates = (w, code, slug) => lots.resolveCode(w.lotRows, w.ledger, code, slug || null);
  const chooseOf = (w, list) => list.map((x) => ({ code: x.code, slug: x.slug, name: w.products.get(x.slug) })).sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  const ambiguous = (w, list) => new StockError('This code is on more than one flavour. Choose one.', 409, { choose: chooseOf(w, list) });
  async function pick(code, slug) {
    const w = await world();
    const found = up(code) ? candidates(w, code, slug) : [];
    if (!found.length) throw new StockError('No lot with that code.', 404);
    if (found.length > 1) throw ambiguous(w, found);
    return { w, cand: found[0] };
  }

  // The two lines of the 8:00 AM summary (spec 6.11). On hold: a hold lot saved more than 24 h before now().
  // Stop soon: a lot the website can still sell whose website stop is today to today + 7 days, with boxes left.
  async function digestLines(todayIst) {   // todayIst is the day the stop-soon window starts from
    const w = await world();
    const cutoff = now() - REVERSE_FREE_MS;   // on hold for more than a day: saved more than 24 h before now()
    const lotsList = await listLots();
    const goodOf = (l) => lotsList.find((x) => x.slug === l.item_slug && x.code === l.lot_code);
    const onHold = w.lotRows.filter((l) => l.status === 'hold' && l.created_at && Date.parse(l.created_at) < cutoff)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      .map((l) => ({ code: l.lot_code, name: w.products.get(l.item_slug), since: lots.todayIst(Date.parse(l.created_at)), good: (goodOf(l) || {}).onHand || 0 }));
    const end = lots.addDays(todayIst, 7);
    const stopSoon = lotsList.filter((l) => (l.status === 'released' || l.status == null) && l.websiteStop && l.websiteStop >= todayIst && l.websiteStop <= end && l.onHand > 0)
      .sort((a, b) => (a.websiteStop < b.websiteStop ? -1 : a.websiteStop > b.websiteStop ? 1 : a.code < b.code ? -1 : 1))
      .map((l) => ({ code: l.code, name: l.name, websiteStop: l.websiteStop, onHand: l.onHand }));
    return { onHold, stopSoon };
  }

  async function listLots(w0) {
    const w = w0 || await world();
    const today = lots.todayIst(now());
    const onHand = new Map();
    for (const r of w.ledger) if (r.lot_code != null) onHand.set(`${r.item_slug}|${r.lot_code}`, (onHand.get(`${r.item_slug}|${r.lot_code}`) || 0) + r.qty);
    const sumOf = (slug, codes) => codes.reduce((a, c) => a + (onHand.get(`${slug}|${c}`) || 0), 0);
    // canShip: a website order can still be packed from it (released or legacy, today on or before the last ship date), so Assign lot
    // offers only those lots (Task 12)
    const entry = (slug, code, status, bake, bb, qty) => {
      const cut = bb ? lots.cutoffs(bb, w.s) : null;
      return { code, slug, name: w.products.get(slug), status, onHand: qty, bakeDate: bake, bestBefore: bb, websiteStop: cut ? cut.websiteStop : null, daysToStop: cut ? daysBetween(today, cut.websiteStop) : null,
        lastShip: cut ? cut.lastShip : null, canShip: lots.eligible({ status, best_before: bb }, 'pack', today, w.s) };
    };
    const out = [];
    for (const l of w.lotRows) {
      const codes = codesOf(w, l);
      const rows = w.ledger.filter((r) => r.item_slug === l.item_slug && codes.includes(r.lot_code) && r.best_before);
      const bb = day(l.best_before) || rows.map((r) => day(r.best_before)).sort()[0] || null;
      const p = lots.parseCode(l.lot_code);
      const e = entry(l.item_slug, l.lot_code, l.status == null ? null : l.status, day(l.bake_date) || (p && p.bakeDate) || null, bb, sumOf(l.item_slug, codes));
      if (lots.ownerHold(l)) { e.ownerHold = true; e.holdReason = l.hold_reason || null; }   // I2: held by the owner, not a new delivery
      out.push(e);
    }
    const legacy = new Map();
    for (const r of w.ledger) {
      if (r.lot_code == null || w.index.has(`${r.item_slug}|${r.lot_code}`)) continue;
      const k = `${r.item_slug}|${r.lot_code}`;
      const e = legacy.get(k) || { slug: r.item_slug, code: r.lot_code, bb: null };
      if (r.best_before && (!e.bb || day(r.best_before) < e.bb)) e.bb = day(r.best_before);
      legacy.set(k, e);
    }
    for (const e of legacy.values()) { const p = lots.parseCode(e.code); out.push(entry(e.slug, e.code, null, p ? p.bakeDate : null, e.bb, sumOf(e.slug, [e.code]))); }
    out.sort((a, b) => (a.bakeDate && b.bakeDate ? (a.bakeDate < b.bakeDate ? 1 : a.bakeDate > b.bakeDate ? -1 : 0) : a.bakeDate ? -1 : b.bakeDate ? 1 : 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || (a.slug < b.slug ? -1 : 1));
    // Rows with no lot from before lots began (lots_from), as one group. Lot-less sales after lots_from belong to Needs attention, not here.
    const lotless = w.ledger.filter((r) => r.lot_code == null);
    if (lotless.length) {
      const from = Date.parse(w.s.lots_from);
      let qty = lotless.reduce((a, r) => a + r.qty, 0);
      if (Number.isFinite(from)) {
        const after = (await store.lotlessSales(new Date(from).toISOString())) || [];
        // Only a lot-less SALE written after lots_from, and an undo of THAT sale (same ref and flavour, as needsLot matches), are left out.
        // An undo of an older pack stays in: the pack itself is still counted here.
        const late = after.filter((r) => Date.parse(r.created_at) > from);
        const lateSales = new Set(late.filter((r) => r.type === 'SALE').map((r) => `${r.ref}|${r.item_slug}`));
        qty -= late.filter((r) => r.type === 'SALE' || lateSales.has(`${r.ref}|${r.item_slug}`)).reduce((a, r) => a + r.qty, 0);
      }
      const when = Number.isFinite(from) ? (() => { const d = lots.todayIst(from); return `${parseInt(d.slice(8, 10), 10)} ${MONTHS[parseInt(d.slice(5, 7), 10) - 1]} ${d.slice(0, 4)}`; })() : null;
      out.push({ code: null, slug: null, name: when ? `Untraced (before ${when})` : 'Untraced (before lots began)', status: null, onHand: qty, bakeDate: null, bestBefore: null, websiteStop: null, daysToStop: null, lastShip: null, canShip: false });
    }
    return out;
  }

  // The best plain city we can read from the order's address (the stored city, else the part before "State - PIN").
  function cityOf(addr) {
    if (!addr) return '';
    if (addr.city) return String(addr.city);
    try { return require('./invoice').parseAddress(addr).city || ''; } catch (e) { return ''; }
  }

  async function lotPage(code, slug) {
    const { w, cand } = await pick(code, slug);
    const lot = cand.row, today = lots.todayIst(now());
    const codes = lot ? codesOf(w, lot) : [cand.code];
    const rows = ((await store.movementsByLots(codes)) || []).filter((m) => m.item_slug === cand.slug);
    const byId = new Map(rows.map((m) => [m.id, m]));
    const n = { received: 0, broken: 0, good: 0, onHand: 0, website: 0, offline: 0, fairs: 0, gifts: 0, samples: 0, damaged: 0, returned: 0, expired: 0, fixes: 0 };
    for (const m of rows) {
      n.onHand += m.qty;
      const o = m.type === 'REVERSAL' && m.reverses_id != null ? byId.get(m.reverses_id) || null : m;   // a reversal counts under the row it cancels
      const t = o ? o.type : 'REVERSAL';
      if (t === 'RECEIVE') n.received += m.qty;
      else if (t === 'DAMAGED') { if (o.delivery_id != null && lot && lot.delivery_id === o.delivery_id) n.broken -= m.qty; else n.damaged -= m.qty; }
      else if (t === 'SALE' || t === 'SALE_UNDO') n.website -= m.qty;
      else if (t === 'OFFLINE_SALE') n.offline -= m.qty;
      else if (t === 'EVENT_SALE' || t === 'EXHIBITION' || t === 'EXHIBITION_RETURN') n.fairs -= m.qty;
      else if (t === 'GIFT') n.gifts -= m.qty;
      else if (t === 'SAMPLE') n.samples -= m.qty;
      else if (t === 'SUPPLIER_RETURN') n.returned -= m.qty;
      else if (t === 'EXPIRED') n.expired -= m.qty;
      else n.fixes += m.qty;   // COUNT_FIX (Fix lot moves too), and the rare USE / RETURN / REPLACEMENT: kept apart so the numbers balance
    }
    n.good = n.received - n.broken;

    // dates
    const parsed = lots.parseCode(cand.code);
    const bb = (lot && day(lot.best_before)) || rows.map((m) => day(m.best_before)).filter(Boolean).sort()[0] || null;
    const cut = bb ? lots.cutoffs(bb, w.s) : null;
    const dates = { bakeDate: (lot && day(lot.bake_date)) || (parsed && parsed.bakeDate) || null, bestBefore: bb, lastShip: cut ? cut.lastShip : null, websiteStop: cut ? cut.websiteStop : null,
      daysToStop: cut ? daysBetween(today, cut.websiteStop) : null, daysToBestBefore: bb ? daysBetween(today, bb) : null };

    // delivery
    let delivery = null;
    if (lot && lot.delivery_id) {
      const d = await store.delivery(lot.delivery_id);
      if (d) delivery = { id: d.id, billNo: d.bill_no, part: d.part, arrivedOn: d.arrived_on ? day(d.arrived_on) : null, photos: Array.isArray(d.photos) ? d.photos : [], supplierBatch: lot.supplier_batch || null, savedBy: d.saved_by_name || d.saved_by_email || null };
    }

    // every website order from the lot (a pack undone is not counted: same match as restoreForOrder)
    const sales = rows.filter((m) => m.type === 'SALE' || m.type === 'SALE_UNDO');
    const undone = new Set(sales.filter((m) => m.type === 'SALE_UNDO').map(saleKey));
    const byOrder = new Map();
    for (const m of sales) {
      if (m.type !== 'SALE' || undone.has(saleKey(m))) continue;
      const o = orderOfRef(m.ref);
      const e = byOrder.get(o.orderId) || { orderId: o.orderId, boxes: 0, at: o.at };
      e.boxes += -m.qty;
      byOrder.set(o.orderId, e);
    }
    const ids = [...byOrder.keys()], found = new Map();
    for (let i = 0; i < ids.length; i += 500) for (const r of (await getDb().getOrdersByIds(ids.slice(i, i + 500))) || []) found.set(r.order_id, r);
    const orders = ids.map((id) => {
      const e = byOrder.get(id), o = found.get(id) || {}, a = o.delivery_address || {};
      return { orderId: id, name: o.customer_name || '', phone: o.customer_phone || '', city: cityOf(o.delivery_address), recipientName: a.recipientName || '', recipientPhone: a.recipientPhone || '', packedAt: o.packed_at || e.at || null, boxes: e.boxes };
    }).sort((a, b) => (Date.parse(a.packedAt) || 0) - (Date.parse(b.packedAt) || 0) || (a.orderId < b.orderId ? -1 : 1));

    const current = lot ? lot.lot_code : cand.code;
    return {
      lot: { code: current, slug: cand.slug, name: w.products.get(cand.slug), status: lot ? (lot.status == null ? null : lot.status) : null, legacy: !lot, aliases: lot ? (lot.aliases || []) : [], supplierBatch: lot ? lot.supplier_batch || null : null,
        holdReason: lot ? lot.hold_reason || null : null, ownerHold: lots.ownerHold(lot), rejectReason: lot ? lot.reject_reason || null : null, releasedAt: lot ? lot.released_at || null : null, releasedBy: lot ? lot.released_by || null : null, checkWeightG: lot ? lot.check_weight_g || null : null },
      delivery, dates, numbers: n,
      perGoodPaise: lot && lot.unit_cost_paise != null ? Number(lot.unit_cost_paise) : null,
      orders,
      sticker: parsed ? lots.stickerCommand(current, Math.max(0, n.onHand), w.s.sticker_flags) : null,
    };
  }

  // The order the flavours are asked for everywhere in the admin (the receiving form): Original, Kesari, Ajwain, Sugar-Lite.
  const FORM_ORDER = ['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar'];
  const PARTIAL_CAP = 50;
  const bare = (v) => up(v).replace(/[-/\s]/g, '');   // "MNGL-261016-01", "KB/OCT26/01" and "kb oct26 01" all become one plain run

  // Part of a code (owner, 9 Nov 2026). Matches a lot's own code, any alias, its supplier batch, or an order ID, as plain upper-case text
  // and again with - / and spaces taken out of both sides. Every status and empty lots are included. Only reads.
  // The cards of every lot, built from one snapshot w (listLots(w) does not read the store again).
  async function lotCards(w) {
    const list = await listLots(w);   // one card's numbers per lot (status, on hand, bake date, website stop), legacy lots included
    const cards = new Map(list.filter((l) => l.code).map((l) => [`${l.slug}|${l.code}`, l]));
    const rowOf = (slug, code) => w.lotRows.find((l) => l.item_slug === slug && l.lot_code === code) || null;
    const card = (l, extra) => {
      const r = rowOf(l.slug, l.code);
      return { code: l.code, slug: l.slug, name: l.name, status: l.status, onHand: l.onHand, bakeDate: l.bakeDate, websiteStop: l.websiteStop, daysToStop: l.daysToStop,
        aliases: r ? (r.aliases || []) : [], supplierBatch: r ? r.supplier_batch || null : null, ...(extra || {}) };
    };
    return { cards, rowOf, card };
  }

  async function partial(w, c, n) {
    const has = (v) => v != null && v !== '' && (up(v).includes(c) || bare(v).includes(n));
    const { cards, rowOf, card } = await lotCards(w);
    const out = [], direct = new Set();
    for (const l of cards.values()) {
      const r = rowOf(l.slug, l.code);
      if (has(l.code) || (r && ((r.aliases || []).some(has) || has(r.supplier_batch)))) { direct.add(`${l.slug}|${l.code}`); out.push(card(l)); }
    }
    // Orders: the id is the part of the ref before "@". Their lots are the SALE rows not undone (the restoreForOrder rule: ref + flavour + lot);
    // lot-less sales are skipped. A lot already listed by its own code is not listed again for an order.
    const { rows, capped } = (await store.saleRowsMatching(n)) || { rows: [], capped: false };   // only the sale rows whose order ID can match, read in the database
    const byOrder = new Map();
    for (const r of rows) {
      const id = orderOfRef(r.ref).orderId;
      if (!has(id)) continue;
      (byOrder.get(id) || byOrder.set(id, []).get(id)).push(r);
    }
    for (const [orderId, sales] of byOrder) {
      const undone = new Set(sales.filter((r) => r.type === 'SALE_UNDO').map(saleKey));
      const g = new Map();
      for (const r of sales) {
        if (r.type !== 'SALE' || r.lot_code == null || undone.has(saleKey(r))) continue;
        const own = w.index.get(`${r.item_slug}|${r.lot_code}`), k = `${r.item_slug}|${own ? own.lot_code : r.lot_code}`;
        g.set(k, (g.get(k) || 0) - r.qty);
      }
      for (const [k, boxes] of g) if (!direct.has(k) && cards.has(k)) out.push(card(cards.get(k), { orderId, boxes }));
    }
    const rank = (slug) => { const i = FORM_ORDER.indexOf(slug); return i < 0 ? FORM_ORDER.length : i; };
    out.sort((a, b) => rank(a.slug) - rank(b.slug) || (a.bakeDate && b.bakeDate ? (a.bakeDate < b.bakeDate ? 1 : a.bakeDate > b.bakeDate ? -1 : 0) : a.bakeDate ? -1 : b.bakeDate ? 1 : 0)
      || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || (String(a.orderId || '') < String(b.orderId || '') ? -1 : String(a.orderId || '') > String(b.orderId || '') ? 1 : 0));
    // capped: more sale rows matched than the store reads, so the order hits may be missing; never look complete (same as the 50 cap)
    return out.length || capped ? { lots: out.slice(0, PARTIAL_CAP), more: out.length > PARTIAL_CAP || capped } : { none: true };
  }

  async function search(q) {
    const c = up(q);
    if (!c) return { none: true };
    const w = await world();
    const answer = (found) => (found.length === 1 ? { lot: { code: found[0].code, slug: found[0].slug } } : { choose: chooseOf(w, found) });
    // one entry per flavour, by its own code or an alias (C1): after Fix lot on one flavour of a shared code (15OCT26 -> MNGK-261016-01),
    // the code still lists every flavour that carries it, so a recall by the printed code misses none
    let found = candidates(w, q, null);
    if (found.length) return answer(found);
    found = w.lotRows.filter((l) => l.supplier_batch && up(l.supplier_batch) === c).map((l) => ({ slug: l.item_slug, code: l.lot_code }));
    if (found.length === 1) return answer(found);
    if (found.length > 1) {   // one supplier batch on several flavours: a list of lots, not a choice
      const { cards, card } = await lotCards(w);
      const rank = (slug) => { const i = FORM_ORDER.indexOf(slug); return i < 0 ? FORM_ORDER.length : i; };
      const lotsOut = found.map((f) => cards.get(`${f.slug}|${f.code}`)).filter(Boolean).map((l) => card(l))
        .sort((a, b) => rank(a.slug) - rank(b.slug) || (a.bakeDate && b.bakeDate ? (a.bakeDate < b.bakeDate ? 1 : a.bakeDate > b.bakeDate ? -1 : 0) : a.bakeDate ? -1 : b.bakeDate ? 1 : 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      return { lots: lotsOut, more: false };
    }
    if (ORDER_ID.test(c)) {
      const sales = (await store.salesOf(c)) || [];
      const undone = new Set(sales.filter((r) => r.type === 'SALE_UNDO').map(saleKey));
      const canon = (slug, code) => { if (code == null) return null; const l = w.index.get(`${slug}|${code}`); return l ? l.lot_code : code; };
      const g = new Map();
      for (const r of sales) {
        if (r.type !== 'SALE' || undone.has(saleKey(r))) continue;
        const code = canon(r.item_slug, r.lot_code), k = `${r.item_slug}|${code || ''}`;
        const e = g.get(k) || { slug: r.item_slug, code, boxes: 0 };
        e.boxes += -r.qty;
        g.set(k, e);
      }
      if (g.size) return { orderLots: [...g.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : String(a.code || '') < String(b.code || '') ? -1 : 1)) };
    }
    const n = bare(c);
    if (c.length < 2 || n.length < 2) return { none: true };   // one character is too loose to mean anything
    return partial(w, c, n);
  }

  // The recall list: one line per order. A gift order carries the recipient in the recipient columns; the buyer columns stay the buyer.
  async function buyersCsv(code, slug) {
    const p = await lotPage(code, slug);
    const cell = (v) => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
    const on = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? lots.todayIst(t) : ''; };
    const lines = ['order_id,buyer_name,buyer_phone,city,recipient_name,recipient_phone,packed_on,boxes'];
    for (const o of p.orders) lines.push([o.orderId, o.name, o.phone, o.city, o.recipientName, o.recipientPhone, on(o.packedAt), o.boxes].map(cell).join(','));
    return lines.join('\n');
  }

  return { save, lastPrefill, findLot, release, digestLines, mailSettled, reject, hold, brokenWhileCartoning, throwExpired, correctDelivery, deliveryPage, fixLot, listLots, lotPage, search, buyersCsv };
}

let real = null;
const instance = () => real || (real = makeDeliveries(require('./inventory').supabaseStore()));

module.exports = { makeDeliveries, instance, PHOTO_PATH, inr };
