'use strict';

/**
 * One Krazy Bakers delivery, every flavour, in one save (spec 6.3, 6.4, 6.10). Lots are created on hold; nothing is sellable until
 * somebody releases them. The whole save is one atomic store call, so a failure leaves nothing behind, and the receipt id
 * makes a resend harmless. Later tasks add release, reject, corrections and lot pages on top of this module.
 */
const { StockError, MAX_QTY } = require('./inventory');
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
  const clashText = (stored, billNo, part) => `Bill ${billNo} part ${part} is already saved (${stored ? dateWords(lots.todayIst(Date.parse(stored.created_at))) : 'earlier'}, ${(stored && (stored.saved_by_name || stored.saved_by_email)) || 'Staff'}). Tap "Add part ${part + 1}" if this is the rest.`;

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

    // bill + part
    const sameBill = (await store.deliveriesByBill(supplier, billNo)) || [];
    let part;
    if (input.addPart) part = sameBill.reduce((m, d) => Math.max(m, d.part || 1), 0) + 1;
    else {
      part = qty(input.part, 'Part', 1) || 1;
      const clash = sameBill.find((d) => (d.part || 1) === part);
      if (clash) throw new StockError(clashText(clash, billNo, part), 400);
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
    const codes = [...(lotRows || []).map((l) => l.lot_code), ...(ledger || []).map((l) => l.lot_code)].filter(Boolean);
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
    if (FREIGHT_KEYS.every((k) => freight[k] === 0)) add('no_freight', 'No freight entered, so the cost per box will look lower than it really is.');
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
      await store.saveDelivery({ d, lots: lotRowsOut, moves });
    } catch (e) {
      if (e && String(e.message).includes(BILL_ONCE)) {
        const now2 = ((await store.deliveriesByBill(supplier, billNo)) || []).find((x) => (x.part || 1) === part);
        throw new StockError(clashText(now2, billNo, part), 400);
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
    for (const k of FREIGHT_KEYS) freight[k] = Number.isFinite(Number(lf[k])) ? Number(lf[k]) : 0;
    return { rates, freight };
  }

  return { save, lastPrefill };
}

let real = null;
const instance = () => real || (real = makeDeliveries(require('./inventory').supabaseStore()));

module.exports = { makeDeliveries, instance, PHOTO_PATH };
