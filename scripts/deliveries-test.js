'use strict';
// Save one delivery (all flavours, lots on hold, every check, safe to resend).   node scripts/deliveries-test.js
const deliveriesModule = require('../utils/deliveries');
const { PHOTO_PATH, inr } = deliveriesModule;
// Every instance gets a silent mailer unless a test passes its own: no test can ever send a real email.
const silentMailer = { sendDeliveryEmail: async () => {}, sendLotReleasedEmail: async () => {} };
const makeDeliveries = (store, opts) => deliveriesModule.makeDeliveries(store, { mailer: silentMailer, ...(opts || {}) });
const { makeInventory, StockError } = require('../utils/inventory');
const { memStore, backfillLots } = require('./inventory-memstore');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ')');
const rejects = async (p, re, m, status) => { try { await p; ok(false, m + ' (did not throw)'); } catch (e) { ok(e instanceof StockError && re.test(e.message) && (!status || e.status === status), m + ' (got: ' + e.message + ' / ' + e.status + ')'); } };

eq([0, 5, 999, 1000, 15040, 99999, 100000, 115000, 1234567, -115000].map((v) => inr(v)), ['0', '5', '999', '1,000', '15,040', '99,999', '1,00,000', '1,15,000', '12,34,567', '-1,15,000'], 'inr groups the Indian way');
eq([inr(1234.5), inr(138.72, true), inr(115000, true), inr(-1234.5), inr(999.999, true)], ['1,234.50', '138.72', '1,15,000.00', '-1,234.50', '1,000.00'], 'inr keeps paise and 2 decimals when asked');

const NOW = Date.parse('2026-11-07T06:00:00Z');   // 7 Nov 2026, 11:30 in India
const A = { actor: { email: 'staff@x.com', name: 'Staff' }, isOwner: false };
const PH = '2026/11/0123456789abcdef.jpg';
const SLUGS = ['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar'];
const RATES = { 'atta-original': 85, 'atta-kesari': 100, 'atta-ajwain': 85, 'atta-lite-sugar': 125 };
const fresh = (wrap) => { const st = memStore('2026-10-16T00:00:00.000Z'); const s = wrap ? wrap(st) : st; return { st, dl: makeDeliveries(s, { now: () => NOW }), inv: makeInventory(st, { now: () => NOW }) }; };
let n = 0;
const rowsOf = (over) => SLUGS.map((slug) => ({ slug, invoiceBoxes: 100, counted: 100, rateRupees: RATES[slug], ...((over || {})[slug] || {}) }));
const input = (o) => ({ id: 'rcpt-' + (++n), billNo: 'A000300', arrivedOn: '2026-11-07', cartons: 10, invoiceRupees: 39500, billedKg: 300,
  freight: { busPerCarton: 150, delhiPerCarton: 50, porter: 300, other: 0 }, bakeDate: '2026-11-05', rows: rowsOf(), ...(o || {}) });

(async () => {
  // a normal delivery
  {
    const { st, dl, inv } = fresh();
    for (const s of SLUGS) await inv.receive({ slug: s, received: 50, lot: '15OCT26', bestBefore: '2027-01-13', actor: A.actor });
    const before = JSON.stringify(await inv.sellable());
    const mvBefore = st.mv.length;
    const r = await dl.save(input({ rows: rowsOf({ 'atta-ajwain': { broken: 2, brokenReason: 'transit', brokenPhoto: PH } }), invoiceRupees: 39500 }), A);
    eq(r.lots.map((l) => l.code), ['MNGO-261105-01', 'MNGK-261105-01', 'MNGA-261105-01', 'MNGL-261105-01'], 'four lot codes');
    const l0 = r.lots[0];
    eq([l0.bakeDate, l0.bestBefore, l0.lastShip, l0.websiteStop], ['2026-11-05', '2027-02-03', '2026-12-15', '2026-12-13'], 'lot dates from Task 2');
    eq([r.delivery.billNo, r.delivery.part, /^rcpt-\d+$/.test(r.delivery.id)], ['A000300', 1, true], 'delivery in result');
    ok(st.mv.length - mvBefore === 5 && st.mv.filter((m) => m.type === 'RECEIVE' && m.delivery_id).length === 4, 'four RECEIVE rows plus one DAMAGED');
    const dm = st.mv.filter((m) => m.type === 'DAMAGED' && m.delivery_id);
    ok(dm.length === 1 && dm[0].qty === -2 && dm[0].reason === 'transit' && dm[0].lot_code === 'MNGA-261105-01' && dm[0].note === 'Broken on arrival (transit). Photo: ' + PH, 'DAMAGED row with reason and photo path');
    const rc = st.mv.find((m) => m.type === 'RECEIVE' && m.item_slug === 'atta-kesari' && m.delivery_id);
    ok(rc.qty === 100 && rc.ref === 'A000300' && rc.best_before === '2027-02-03' && rc.amount_paise === 1000000 && rc.actor_email === 'staff@x.com', 'RECEIVE row fields');
    const lots = (await st.lots()).filter((l) => l.delivery_id);
    ok(lots.length === 4 && lots.every((l) => l.status === 'hold' && l.unit_cost_paise > 0), 'lots are on hold with a cost');
    eq(JSON.stringify(await inv.sellable()), before, 'sellable unchanged while lots are on hold');
    ok(r.notes.some((x) => /Send the bus company a written note of the breakage \(claims need notice within 180 days\)\./.test(x)), 'transit note');
    const d = await st.delivery(r.delivery.id);
    ok(d.freight.bus_per_carton === 150 && d.invoice_paise === 3950000 && d.gst_paise === 0 && d.cartons === 10 && d.saved_by_name === 'Staff' && d.input.billNo === 'A000300' && d.result.lots.length === 4, 'delivery row');
  }
  // landed cost equals the Task 2 example
  {
    const { dl } = fresh();
    const r = await dl.save(input({ invoiceRupees: 18500, rows: [{ slug: 'atta-original', invoiceBoxes: 100, counted: 100, broken: 2, brokenReason: 'transit', brokenPhoto: PH, rateRupees: 85 }, { slug: 'atta-kesari', invoiceBoxes: 100, counted: 100, rateRupees: 100 }] }), A);
    eq(r.lots.map((l) => [l.good, l.perGoodPaise]), [[98, 9847], [100, 11150]], 'landed cost matches the Task 2 example');
  }
  // two Kesari rows: different bakes, same bake
  {
    const { dl } = fresh();
    const r = await dl.save(input({ invoiceRupees: 20000, rows: [{ slug: 'atta-kesari', invoiceBoxes: 100, counted: 100, rateRupees: 100, bakeDate: '2026-11-05' }, { slug: 'atta-kesari', invoiceBoxes: 100, counted: 100, rateRupees: 100, bakeDate: '2026-11-06' }] }), A);
    eq(r.lots.map((l) => l.code), ['MNGK-261105-01', 'MNGK-261106-01'], 'two Kesari bakes');
    const f = fresh();
    const r2 = await f.dl.save(input({ invoiceRupees: 20000, rows: [{ slug: 'atta-kesari', invoiceBoxes: 100, counted: 100, rateRupees: 100 }, { slug: 'atta-kesari', invoiceBoxes: 100, counted: 100, rateRupees: 100 }] }), A);
    eq(r2.lots.map((l) => l.code), ['MNGK-261105-01', 'MNGK-261105-02'], 'same bake gives -01 and -02');
  }
  // R8: sequence counts stock_lots and the ledger's codes
  {
    const { st, dl, inv } = fresh();
    await inv.receive({ slug: 'atta-kesari', received: 5, lot: 'MNGK-261105-01', bestBefore: '2027-02-03', actor: A.actor });   // ledger only
    await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261105-02', bake_date: '2026-11-05', best_before: '2027-02-03', status: 'released' }]);
    const r = await dl.save(input({ invoiceRupees: 10000, rows: [{ slug: 'atta-kesari', invoiceBoxes: 100, counted: 100, rateRupees: 100 }] }), A);
    eq(r.lots[0].code, 'MNGK-261105-03', 'sequence continues past ledger and lot codes');
  }
  // hard blocks
  {
    const { dl } = fresh();
    const bad = (o, re, m) => rejects(dl.save(input(o), A), re, m, 400);
    await bad({ id: '' }, /no receipt number/, 'missing id');
    await bad({ id: 'a b' }, /no receipt number/, 'bad id characters');
    await bad({ billNo: '' }, /bill number/i, 'bill number missing');
    await bad({ bakeDate: '' }, /Enter the bake date/, 'bake date missing');
    await bad({ bakeDate: '2026-11-08', arrivedOn: '2026-11-07' }, /cannot be after the day it arrived/, 'bake after arrival');
    await bad({ arrivedOn: '2026-11-08' }, /Arrived on cannot be in the future\./, 'arrival in future');
    await bad({ rows: rowsOf({ 'atta-kesari': { bakeDate: '2026-11-09' } }) }, /cannot be after the day it arrived/, 'row bake date after arrival');
    await bad({ rows: rowsOf({ 'atta-kesari': { counted: '' } }) }, /counted/i, 'counted empty with invoice boxes');
    await bad({ rows: rowsOf({ 'atta-kesari': { counted: 5, broken: 6, brokenReason: 'transit', brokenPhoto: PH, diffReason: 'x' } }) }, /more than/, 'broken more than counted');
    await bad({ rows: rowsOf({ 'atta-kesari': { broken: 2, brokenReason: 'transit' } }) }, /photo/i, 'broken without photo');
    await bad({ rows: rowsOf({ 'atta-kesari': { broken: 2, brokenPhoto: PH } }) }, /Choose why the boxes broke: on the bus or at the bakery\./, 'broken without reason');
    await bad({ rows: rowsOf({ 'atta-kesari': { broken: 2, brokenReason: 'transit', brokenPhoto: '../../etc/passwd' } }) }, /That photo did not upload\. Take it again\./, 'bad broken photo path');
    await bad({ photos: ['nope.jpg'] }, /That photo did not upload\. Take it again\./, 'bad bill photo path');
    await bad({ rows: rowsOf({ 'atta-kesari': { counted: 99 } }) }, /why/i, 'counted differs from invoice without reason');
    await bad({ rows: rowsOf({ 'atta-kesari': { counted: 100001, invoiceBoxes: 100001 } }) }, /whole number from 0 to 100000/, 'out of range');
    await bad({ rows: rowsOf({ 'atta-kesari': { counted: -1, diffReason: 'x' } }) }, /whole number from 0 to 100000/, 'negative');
    await bad({ rows: rowsOf({ 'atta-kesari': { counted: 1.5, diffReason: 'x' } }) }, /whole number/, 'fraction');
    await bad({ rows: rowsOf({ 'atta-kesari': { slug: 'atta-nope' } }) }, /flavour/i, 'unknown flavour');
    await bad({ freight: { busPerCarton: 100001 } }, /freight|bus/i, 'freight out of range');
    await bad({ rows: [] }, /at least one/i, 'no rows');
    await bad({ rows: rowsOf({ 'atta-original': { counted: 0, diffReason: 'none came' }, 'atta-kesari': { counted: 0, diffReason: 'x' }, 'atta-ajwain': { counted: 0, diffReason: 'x' }, 'atta-lite-sugar': { counted: 0, diffReason: 'x' } }) }, /at least one/i, 'every row counted 0');
  }
  // bill clash, part 2, and the race
  {
    const { st, dl } = fresh();
    const first = await dl.save(input(), A);
    const when = new Date(Date.parse((await st.delivery(first.delivery.id)).created_at) + 330 * 60000).toISOString().slice(0, 10);
    const words = parseInt(when.slice(8), 10) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(when.slice(5, 7), 10) - 1];
    await rejects(dl.save(input(), A), new RegExp('^Bill A000300 part 1 is already saved \\(' + words + ', Staff\\)\\. Tap "Add part 2" if this is the rest\\.$'), 'same bill and part refused with the exact words', 400);
    await rejects(dl.save(input({ billNo: 'a000300' }), A), /already saved/, 'bill number match ignores case');
    const p2 = await dl.save(input({ addPart: true, rows: [{ slug: 'atta-kesari', invoiceBoxes: 20, counted: 20, rateRupees: 100 }], invoiceRupees: 2000, confirm: ['cost_jump'] }), A);
    eq(p2.delivery.part, 2, 'addPart saves as part 2');
    const p3 = await dl.save(input({ addPart: true, rows: [{ slug: 'atta-kesari', invoiceBoxes: 20, counted: 20, rateRupees: 100 }], invoiceRupees: 2000, confirm: ['cost_jump'] }), A);
    eq(p3.delivery.part, 3, 'next free part');
    ok(p2.lots[0].code === 'MNGK-261105-02', 'part 2 lot continues the sequence');
    ok(first.delivery.part === 1, 'first stays part 1');
  }
  {
    let thrown = false;
    const { dl } = fresh((st) => ({ ...st, deliveriesByBill: async (...a) => (thrown ? [{ part: 1, created_at: '2026-11-05T08:00:00Z', saved_by_name: 'Staff' }] : []), saveDelivery: async () => { thrown = true; throw new Error('duplicate key value violates unique constraint "stock_deliveries_bill_part_once"'); } }));
    await rejects(dl.save(input(), A), /^Bill A000300 part 1 is already saved \(5 Nov, Staff\)\. Tap "Add part 2" if this is the rest\.$/, 'the database clash becomes the same plain message', 400);
  }
  // resend and atomicity
  {
    const { st, dl } = fresh();
    const i = input({ id: 'same-receipt' });
    const r1 = await dl.save(i, A);
    const mv = st.mv.length;
    const r2 = await dl.save({ ...i, rows: rowsOf({ 'atta-kesari': { counted: 55, diffReason: 'x' } }), billNo: 'OTHER' }, A);
    ok(r2.again === true && JSON.stringify(r2.lots) === JSON.stringify(r1.lots) && st.mv.length === mv && (await st.lots()).length === 4, 'resend with edited fields saves once');
    const r3 = await dl.save({ id: 'same-receipt' }, A);
    ok(r3.again === true, 'resend wins before validation');
  }
  {
    const { st, dl } = fresh((s) => ({ ...s, saveDelivery: (a) => s.saveDelivery({ ...a, moves: [...a.moves, { item_slug: 'atta-original', qty: 1, type: 'BOGUS' }] }) }));
    let threw = false; try { await dl.save(input(), A); } catch (e) { threw = true; }
    ok(threw && st.mv.length === 0 && (await st.lots()).length === 0 && (await st.delivery('rcpt-x')) === null && (await st.lastDelivery()) === null, 'a save that fails on its last move leaves nothing');
  }
  // short and over delivery
  {
    const { dl } = fresh();
    const r = await dl.save(input({ invoiceRupees: 39500, rows: rowsOf({ 'atta-original': { counted: 95, diffReason: '5 short' }, 'atta-kesari': { counted: 105, diffReason: '5 extra' }, 'atta-lite-sugar': { counted: 0, diffReason: 'did not come' } }) }), A);
    eq(r.toRaise, [{ slug: 'atta-original', invoice: 100, counted: 95 }, { slug: 'atta-kesari', invoice: 100, counted: 105 }, { slug: 'atta-lite-sugar', invoice: 100, counted: 0 }], 'short, over and none came are listed');
    eq(r.lots.map((l) => l.slug), ['atta-original', 'atta-kesari', 'atta-ajwain'], 'counted 0 makes no lot');
  }
  // skipped row, row bake date, default rows
  {
    const { st, dl } = fresh();
    const r = await dl.save(input({ invoiceRupees: 8500, rows: [{ slug: 'atta-original', invoiceBoxes: 100, counted: 100, rateRupees: 85, bakeDate: '2026-11-04' }, { slug: 'atta-kesari', invoiceBoxes: '', counted: '' }] }), A);
    eq(r.lots.map((l) => l.code), ['MNGO-261104-01'], 'empty row skipped; row bake date used');
  }
  // warnings
  const warn = async (o, key, m, extraConfirm) => {
    const { st, dl } = fresh();
    try { await dl.save(input(o), A); ok(false, m + ' (no 409)'); } catch (e) { ok(e instanceof StockError && e.status === 409 && e.message === 'Check these before saving' && e.extra.warnings.some((w) => w.key === key && w.text.length > 10), m + ' appears (got ' + e.message + ')'); }
    const r = await dl.save(input({ ...o, confirm: [key, ...(extraConfirm || [])] }), A);
    ok(r.warnings.some((w) => w.key === key) && r.lots.length > 0, m + ' passes once confirmed');
    return r;
  };
  await warn({ invoiceRupees: 40000 }, 'invoice_mismatch', 'invoice mismatch');
  await warn({ cartons: 10, freight: {} }, 'no_freight', 'no freight');
  await warn({ rows: rowsOf({ 'atta-original': { invoiceBoxes: 5000, counted: 5000 } }), invoiceRupees: 39500 + 5000 * 85 - 8500 }, 'large', 'large delivery');
  await warn({ bakeDate: '2026-10-25', oldBakeReason: 'Bakery held it back' }, 'old_bake', 'old bake');
  {
    const { dl } = fresh();
    try { await dl.save(input({ bakeDate: '2026-10-25' }), A); } catch (e) { const w = e.extra.warnings.find((x) => x.key === 'old_bake'); eq(w.text, 'Atta Original, Atta Kesari, Atta Ajwain and Atta Sugar-Lite were baked on 25 Oct, 13 days before they arrived. The website will stop selling them on 2 Dec.', 'old bake: four flavours on one date make one sentence'); }
    try { await dl.save(input({ bakeDate: '2026-10-25', rows: rowsOf({ 'atta-kesari': { bakeDate: '2026-10-27' }, 'atta-ajwain': { bakeDate: '2026-10-27' } }) }), A); } catch (e) { const w = e.extra.warnings.find((x) => x.key === 'old_bake'); eq(w.text, 'Atta Original and Atta Sugar-Lite were baked on 25 Oct, 13 days before they arrived. The website will stop selling them on 2 Dec. Atta Kesari and Atta Ajwain were baked on 27 Oct, 11 days before they arrived. The website will stop selling them on 4 Dec.', 'old bake: two bake dates make two sentences, flavours in form order'); }
    try { await dl.save(input({ bakeDate: '2026-11-05', rows: rowsOf({ 'atta-kesari': { bakeDate: '2026-10-29' } }) }), A); } catch (e) { const w = e.extra.warnings.find((x) => x.key === 'old_bake'); eq(w.text, 'Atta Kesari was baked on 29 Oct, 9 days before it arrived. The website will stop selling it on 6 Dec.', 'old bake: one flavour reads singular'); }
    try { await dl.save(input({ invoiceRupees: 115000 }), A); } catch (e) { const w = e.extra.warnings.find((x) => x.key === 'invoice_mismatch'); ok(/\(Rs 1,15,000\)/.test(w.text) && /Rs [0-9,]+\)\.$/.test(w.text) && !/Rs \d{4,}/.test(w.text), 'rupees in warnings use Indian grouping: ' + w.text); }
    await rejects(dl.save(input({ bakeDate: '2026-10-25', confirm: ['old_bake'] }), A), /^Add a reason why the bake date is old\.$/, 'old bake confirmed without reason refused', 400);
  }
  {
    const r = await warn({ bakeDate: '2026-10-05', oldBakeReason: 'x' }, 'stop_soon', 'website stop soon', ['old_bake']);
    ok(r.warnings.some((w) => w.key === 'old_bake'), 'both warnings listed');
  }
  {
    // cost jump needs the first delivery in the same store
    const { dl } = fresh();
    const a = await dl.save(input({ billNo: 'B1' }), A);
    ok(a.lots[0].prevPerGoodPaise === null, 'first delivery has no previous cost');
    try { await dl.save(input({ billNo: 'B2', rows: rowsOf({ 'atta-original': { rateRupees: 100 } }), invoiceRupees: 41000 }), A); ok(false, 'cost_jump 409'); } catch (e) { ok(e.status === 409 && e.extra.warnings.map((w) => w.key).join() === 'cost_jump', 'only cost_jump raised: ' + (e.extra && JSON.stringify(e.extra.warnings))); }
    const b = await dl.save(input({ billNo: 'B2', rows: rowsOf({ 'atta-original': { rateRupees: 100 } }), invoiceRupees: 41000, confirm: ['cost_jump'] }), A);
    ok(b.lots[0].prevPerGoodPaise === a.lots[0].perGoodPaise && b.lots[1].prevPerGoodPaise === a.lots[1].perGoodPaise, 'previous cost carried');
    // an increase of 10% or less is not flagged
    await dl.save(input({ billNo: 'B3', rows: rowsOf({ 'atta-original': { rateRupees: 90 } }), invoiceRupees: 39500 + 500 }), A);
  }
  // GST
  {
    const { st, dl } = fresh();
    const rows = [{ slug: 'atta-original', invoiceBoxes: 100, counted: 100, rateRupees: 85 }];
    const r = await dl.save(input({ rows, freight: { busPerCarton: 1 }, invoiceRupees: 8925, gstRupees: 425 }), A);
    ok(!r.warnings.some((w) => w.key === 'invoice_mismatch'), 'GST invoice with total = lines + GST raises no mismatch');
    eq(r.lots[0].perGoodPaise, Math.round((850000 + 1000) / 100), 'GST never enters landed cost');
    ok((await st.delivery(r.delivery.id)).gst_paise === 42500, 'gst_paise stored');
    const f = fresh();
    await rejects(f.dl.save(input({ rows, invoiceRupees: 8925 }), A), /Check these/, 'same total without GST entered is a mismatch', 409);
  }
  // fix round 1
  {
    // concurrent resend: both lookups miss while the store already holds the id
    const a = fresh();
    const i = input({ id: 'dbl-1' });
    const r1 = await a.dl.save(i, A);
    const wrap = (st) => ({ ...st, delivery: async () => null, deliveriesByBill: async () => [] });
    const dl2 = makeDeliveries(wrap(a.st), { now: () => NOW });
    const r2 = await dl2.save({ ...i, rows: rowsOf({ 'atta-kesari': { counted: 90, broken: 0, diffReason: 'x' } }), confirm: ['cost_jump'] }, A);
    ok(r2.again === true && JSON.stringify(r2.lots) === JSON.stringify(r1.lots), 'concurrent resend (store says again) returns the stored result');
    // same, via the bill-once race: saveDelivery throws the clash while the receipt exists
    let seen = false;
    const b = fresh();
    await b.dl.save(i, A);
    const dl3 = makeDeliveries({ ...b.st, deliveriesByBill: async () => [], delivery: async (x) => (seen ? b.st.delivery(x) : null), saveDelivery: async () => { seen = true; throw new Error('duplicate key value violates unique constraint "stock_deliveries_bill_part_once"'); } }, { now: () => NOW });
    const r3 = await dl3.save(i, A);
    ok(r3.again === true && r3.lots.length === 4, 'bill-once race with the same receipt returns the stored result');
  }
  {
    const { dl } = fresh();
    await rejects(dl.save(input({ bakeDate: '2026-12-25', rows: rowsOf().map((r) => ({ ...r, bakeDate: '2026-11-05' })) }), A), /cannot be after the day it arrived/, 'future top bake date refused even when rows have their own', 400);
  }
  {
    const { dl } = fresh();
    const r = await warn.call(null, { cartons: '', freight: { busPerCarton: 150, delhiPerCarton: 50 } }, 'no_freight', 'no freight when cartons are empty');
  }
  {
    const { dl } = fresh();
    await dl.save(input(), A);
    await dl.save(input({ addPart: true, rows: [{ slug: 'atta-kesari', invoiceBoxes: 20, counted: 20, rateRupees: 100 }], invoiceRupees: 2000, confirm: ['cost_jump'] }), A);
    await rejects(dl.save(input({ part: 1 }), A), /part 1 is already saved .*Tap "Add part 3"/, 'clash names the next free part', 400);
  }
  {
    const { st, dl } = fresh();
    await st.insertLots([{ item_slug: 'atta-kesari', lot_code: '27OCT26', aliases: ['MNGK-261027-01'], bake_date: '2026-10-27', best_before: '2027-01-25', status: 'released' }]);
    const r = await dl.save(input({ bakeDate: '2026-10-27', invoiceRupees: 10000, confirm: ['old_bake', 'stop_soon', 'cost_jump'], oldBakeReason: 'x', arrivedOn: '2026-11-07', rows: [{ slug: 'atta-kesari', invoiceBoxes: 100, counted: 100, rateRupees: 100 }] }), A);
    eq(r.lots[0].code, 'MNGK-261027-02', 'sequence skips an alias already printed on boxes');
  }
  // prefill
  {
    const { dl } = fresh();
    // no earlier delivery: the 8 Nov facts (Delhi unloading Rs 20 a carton, porter Rs 2,000 a trip; bus fare per carton not known yet)
    eq(await dl.lastPrefill(), { rates: RATES, freight: { busPerCarton: 0, delhiPerCarton: 20, porter: 2000, other: 0 } }, 'prefill defaults');
    await dl.save(input({ billNo: 'P1', rows: [{ slug: 'atta-original', invoiceBoxes: 100, counted: 100, rateRupees: 88 }], invoiceRupees: 8800 }), A);
    const p = await dl.lastPrefill();
    eq([p.rates['atta-original'], p.rates['atta-kesari'], p.freight.busPerCarton, p.freight.delhiPerCarton, p.freight.porter, p.freight.other], [88, 100, 150, 50, 300, 0], 'prefill from the last delivery (its freight wins over the defaults), default rates for flavours it lacked');
    await dl.save(input({ billNo: 'P2', freight: { busPerCarton: 0, delhiPerCarton: 0, porter: 0, other: 0 }, confirm: ['no_freight'], rows: [{ slug: 'atta-original', invoiceBoxes: 100, counted: 100, rateRupees: 88 }], invoiceRupees: 8800 }), A);
    eq((await dl.lastPrefill()).freight, { busPerCarton: 0, delhiPerCarton: 0, porter: 0, other: 0 }, 'a last delivery with no freight prefills 0, not the defaults');
  }
  // preview (the review screen before Save): the same checks, codes, dates and costs, and nothing written
  {
    const { st, dl } = fresh();
    await dl.save(input({ billNo: 'PV0', rows: [{ slug: 'atta-original', invoiceBoxes: 100, counted: 100, rateRupees: 50 }], invoiceRupees: 5000 }), A);   // a cheap last lot, so this one jumps
    const mv = st.mv.length, lotsBefore = JSON.stringify(await st.lots()), last = JSON.stringify(await st.lastDelivery());
    const inp = input({ billNo: 'PV1', bakeDate: '2026-10-27', invoiceRupees: 1, rows: rowsOf({ 'atta-original': { broken: 2, brokenReason: 'transit', brokenPhoto: PH } }) });
    const p = await dl.save(inp, { ...A, preview: true });
    ok(p.preview === true && !p.again, 'preview answers preview: true');
    eq(p.lots.map((l) => l.code), ['MNGO-261027-01', 'MNGK-261027-01', 'MNGA-261027-01', 'MNGL-261027-01'], 'preview gives the codes the save would give');
    const o0 = p.lots[0];
    eq([o0.bakeDate, o0.bestBefore, o0.lastShip, o0.websiteStop, o0.good, o0.prevPerGoodPaise != null], ['2026-10-27', '2027-01-25', '2026-12-06', '2026-12-04', 98, true], 'preview lot: four dates, good boxes and the previous lot cost');
    ok(o0.perGoodPaise > 0, 'preview lot: cost per good box');
    eq(p.warnings.map((w) => w.key).sort(), ['cost_jump', 'invoice_mismatch', 'old_bake'], 'preview lists every warning, none confirmed');
    eq([p.delivery.id, p.delivery.billNo, p.delivery.part], [inp.id, 'PV1', 1], 'preview delivery');
    ok(p.notes.length === 1 && Array.isArray(p.toRaise), 'preview notes and toRaise');
    const p2 = await dl.save({ ...inp, confirm: ['old_bake'] }, { ...A, preview: true });
    ok(p2.preview === true && p2.warnings.some((w) => w.key === 'old_bake'), 'preview still lists a confirmed warning and needs no old-bake reason');
    ok(st.mv.length === mv && JSON.stringify(await st.lots()) === lotsBefore && JSON.stringify(await st.lastDelivery()) === last && !(await st.delivery(inp.id)), 'preview writes nothing');
    await rejects(dl.save({ ...inp, billNo: '' }, { ...A, preview: true }), /^Enter the bill number\.$/, 'preview runs the hard blocks', 400);
    await rejects(dl.save({ ...inp, billNo: 'PV0' }, { ...A, preview: true }), /^Bill PV0 part 1 is already saved/, 'preview refuses a bill and part already saved', 400);
    const r = await dl.save({ ...inp, confirm: ['old_bake', 'cost_jump', 'invoice_mismatch'], oldBakeReason: 'bus strike' }, A);
    eq(r.lots.map((l) => l.code), p.lots.map((l) => l.code), 'the save gives the codes the preview showed');
    const again = await dl.save(inp, { ...A, preview: true });
    ok(again.again === true && !again.preview && again.delivery.id === inp.id && again.lots.length === 4, 'preview of a receipt already saved answers its stored result with again: true');
  }
  ok(PHOTO_PATH.test(PH) && !PHOTO_PATH.test('2026/11/xyz.jpg'), 'PHOTO_PATH');

  // ---- Release, Reject, Hold (Task 5) ----
  const OWNER = { actor: { email: 'owner@x.com', name: 'Owner' }, isOwner: true };
  const saveOne = async (dl, extra) => { const r = await dl.save(input({ billNo: 'R' + (++n), ...(extra || {}) }), A); return r.lots; };
  const sellOf = async (inv, slug) => (await inv.sellable())[slug];
  const useRows = (st, code) => st.mv.filter((m) => m.type === 'USE' && m.ref === code);
  const packBoxes = async (st, slug) => (await st.byLot()).filter((r) => r.item_slug === slug).reduce((a, r) => a + r.qty, 0);
  const KES = 'MNGK-261105-01';
  const oneKesari = (counted, broken) => ({ rows: [{ slug: 'atta-kesari', invoiceBoxes: 100, counted, broken, brokenReason: broken ? 'transit' : undefined, brokenPhoto: broken ? PH : undefined, diffReason: 'x', rateRupees: 100 }], invoiceRupees: 10000 });
  const stockPack = async (st, inv) => { await inv.receive({ slug: 'mono-kesari', received: 500, actor: A.actor }); await inv.receive({ slug: 'label-stamp', received: 500, actor: A.actor }); };
  {
    const { st, dl, inv } = fresh();
    await stockPack(st, inv);
    await saveOne(dl, oneKesari(100, 2));
    ok((await sellOf(inv, 'atta-kesari')) == null || (await sellOf(inv, 'atta-kesari')) === 0, 'held lot is not sellable');
    const kBefore = await packBoxes(st, 'mono-kesari');
    const r = await dl.release({ code: KES, tasted: true, weightG: 275, note: ' ok ' }, A);
    eq([r.lot.status, r.lot.released_by, r.lot.check_weight_g, r.lot.check_note, r.warnings, 'packagingRows' in r], ['released', 'staff@x.com', 275, 'ok', [], false], 'staff release works');
    ok(/^2026-11-07T06:00:00/.test(r.lot.released_at), 'released_at from now()');
    eq([useRows(st, KES).length, st.mv.filter((m) => m.type === 'USE').length], [0, 0], 'Release writes no USE rows (packaging is hand-kept)');
    eq(await packBoxes(st, 'mono-kesari'), kBefore, 'packaging stock is untouched by Release');
    eq(await sellOf(inv, 'atta-kesari'), 98, 'released lot is in sellable');
    const stored = (await st.lots()).find((l) => l.lot_code === KES);
    ok(stored.status === 'released' && stored.released_by === 'staff@x.com', 'stored lot updated');
    await rejects(dl.release({ code: KES, tasted: true, weightG: 275 }, A), /^This lot is already released\.$/, 'release of a released lot refused', 400);
    // hold then release again: still no USE rows
    await rejects(dl.hold({ code: KES, reason: 'complaint' }, A), /^Only the owner can reject or hold a lot\.$/, 'staff Hold refused', 403);
    await dl.hold({ code: KES, reason: 'complaint' }, OWNER);
    const l1 = (await st.lots()).find((l) => l.lot_code === KES);
    ok(l1.status === 'hold' && l1.hold_reason === 'complaint', 'hold sets status and reason');
    ok(!(await sellOf(inv, 'atta-kesari')), 'held lot leaves sellable');
    const ctx = await require('../utils/inventory').lotContext(st, NOW);
    const lotsRule = require('../utils/lots');
    ok(!lotsRule.eligible({ status: ctx.meta['atta-kesari|' + KES].status, best_before: l1.best_before }, 'pack', ctx.today, ctx.s), 'pack allocation skips the held lot');
    await inv.take({ slug: 'atta-kesari', qty: 1, type: 'SAMPLE', who: 'x', allowNegative: true, actor: A.actor });
    ok(st.mv.filter((m) => m.type === 'SAMPLE')[0].lot_code == null, 'a take-out does not use the held lot');
    await rejects(dl.reject({ code: KES, reason: 'bad' }, OWNER), /^This lot was released before, so it cannot be rejected\.$/, 'reject after an earlier release refused', 400);
    const r2 = await dl.release({ code: KES, tasted: true, weightG: 280 }, OWNER);
    eq([useRows(st, KES).length, st.mv.filter((m) => m.type === 'USE').length], [0, 0], 'second release writes no USE rows either');
    eq(await sellOf(inv, 'atta-kesari'), 97, 'released again and sellable');
    await rejects(dl.reject({ code: KES, reason: 'bad' }, OWNER), /^Only a lot still on hold can be rejected\. Use Hold this lot\.$/, 'reject on a released lot refused', 400);
  }
  // refusals and warnings
  {
    const { st, dl, inv } = fresh();
    await stockPack(st, inv);
    await saveOne(dl, oneKesari(100, 2));
    await rejects(dl.release({ code: KES, weightG: 275 }, A), /^Tick that you tasted one box and it is OK\.$/, 'needs tasted', 400);
    await rejects(dl.release({ code: KES, tasted: 'yes', weightG: 275 }, A), /Tick that you tasted/, 'tasted must be true', 400);
    await rejects(dl.release({ code: KES, tasted: true }, A), /^Enter the weight of one box in grams\.$/, 'needs a weight', 400);
    await rejects(dl.release({ code: KES, tasted: true, weightG: 99 }, A), /Enter the weight/, 'weight under 100', 400);
    await rejects(dl.release({ code: KES, tasted: true, weightG: 1001 }, A), /Enter the weight/, 'weight over 1000', 400);
    await rejects(dl.release({ code: KES, tasted: true, weightG: 250.5 }, A), /Enter the weight/, 'weight must be whole', 400);
    eq(useRows(st, KES).length + (await st.lots()).filter((l) => l.status === 'released').length, 0, 'refusals write nothing');
    const r = await dl.release({ code: KES, tasted: true, weightG: 245, packaging: [{ slug: 'mono-kesari', qty: 90 }, { slug: 'label-stamp', qty: 0 }] }, OWNER);
    eq(r.warnings, ['One box weighed 245 g, under the 250 g on the pack. Weigh a second box.'], '245 g releases with a warning');
    eq([st.mv.filter((m) => m.type === 'USE').length, 'packagingRows' in r], [0, false], 'a packaging list sent with Release is ignored: no USE rows');
  }
  // no packaging at all in the stock: Release neither warns nor writes anything about packaging
  {
    const { st, dl } = fresh();
    await saveOne(dl, oneKesari(100, 2));
    const r = await dl.release({ code: KES, tasted: true, weightG: 300 }, A);
    eq([r.warnings, await packBoxes(st, 'mono-kesari'), st.mv.filter((m) => m.type === 'USE').length], [[], 0, 0], 'no packaging warning and no packaging movement');
  }
  // reject
  {
    const { st, dl, inv } = fresh();
    await saveOne(dl, { ...oneKesari(100, 2), billNo: 'BILLX' });
    const before = await sellOf(inv, 'atta-kesari');
    await rejects(dl.reject({ code: KES, reason: 'bad' }, A), /^Only the owner can reject or hold a lot\.$/, 'staff Reject refused', 403);
    await rejects(dl.reject({ code: KES }, OWNER), /^Add a reason\.$/, 'reject needs a reason', 400);
    const r = await dl.reject({ code: KES, reason: 'stale taste' }, OWNER);
    const sr = st.mv.filter((m) => m.type === 'SUPPLIER_RETURN');
    ok(sr.length === 1 && sr[0].qty === -98 && sr[0].ref === 'BILLX' && sr[0].lot_code === KES && sr[0].item_slug === 'atta-kesari', 'SUPPLIER_RETURN of -98 with the bill number');
    eq([r.lot.status, r.lot.reject_reason, (await st.lots())[0].status], ['rejected', 'stale taste', 'rejected'], 'rejected with a reason');
    eq(await sellOf(inv, 'atta-kesari'), before, 'sellable unchanged by reject');
    await rejects(dl.release({ code: KES, tasted: true, weightG: 300 }, A), /^This lot was rejected or corrected, so it cannot be released\.$/, 'rejected lot cannot be released', 400);
    eq(useRows(st, KES).length, 0, 'reject uses no packaging');
  }
  // hold needs a reason and a released lot
  {
    const { st, dl, inv } = fresh();
    await stockPack(st, inv);
    await saveOne(dl, oneKesari(100, 0));
    await rejects(dl.hold({ code: KES, reason: 'x' }, OWNER), /^Only a released lot can be put on hold\.$/, 'hold needs a released lot', 400);
    await dl.release({ code: KES, tasted: true, weightG: 300 }, A);
    await rejects(dl.hold({ code: KES }, OWNER), /^Add a reason\.$/, 'hold needs a reason', 400);
    await rejects(dl.hold({ code: KES, reason: 'x', isOwner: true }, A), /Only the owner/, 'isOwner comes from the second argument', 403);
    await rejects(dl.hold({ code: 'MNGK-250101-01', reason: 'x' }, OWNER), /^No lot with that code\.$/, 'unknown code', 404);
  }
  // legacy codes shared by flavours, and ledger-only lots
  {
    const { st, dl, inv } = fresh();
    await st.insertLots([
      { item_slug: 'atta-kesari', lot_code: '15OCT26', aliases: ['MNGK-261016-01'], bake_date: '2026-10-16', best_before: '2027-01-13', status: 'released' },
      { item_slug: 'atta-original', lot_code: '15OCT26', aliases: ['MNGO-261016-01'], bake_date: '2026-10-16', best_before: '2027-01-13', status: 'released' },
    ]);
    for (const s of ['atta-kesari', 'atta-original']) await inv.receive({ slug: s, received: 50, lot: '15OCT26', bestBefore: '2027-01-13', actor: A.actor });
    try { await dl.hold({ code: '15OCT26', reason: 'x' }, OWNER); ok(false, 'ambiguous did not throw'); } catch (e) {
      ok(e instanceof StockError && e.status === 409 && e.message === 'This code is on more than one flavour. Choose one.', 'ambiguous legacy code answers 409');
      eq(e.extra.choose.map((c) => [c.code, c.slug, c.name]).sort(), [['15OCT26', 'atta-kesari', 'Atta Kesari'], ['15OCT26', 'atta-original', 'Atta Original']], 'choose list');
    }
    await dl.hold({ code: '15OCT26', slug: 'atta-original', reason: 'recall' }, OWNER);
    eq((await st.lots()).map((l) => [l.item_slug, l.status]), [['atta-kesari', 'released'], ['atta-original', 'hold']], 'slug picks the right flavour');
    await dl.hold({ code: 'MNGK-261016-01', reason: 'by alias' }, OWNER);
    eq((await st.lots())[0].status, 'hold', 'an alias opens its lot');
    // ledger only: received through the old form after the migration, no lots row
    await inv.receive({ slug: 'atta-ajwain', received: 20, lot: 'MNGA-261101-01', bestBefore: '2027-01-30', actor: A.actor });
    await inv.receive({ slug: 'atta-lite-sugar', received: 20, lot: 'LEGACY1', bestBefore: '2027-01-30', actor: A.actor });
    await inv.receive({ slug: 'atta-ajwain', received: 20, lot: 'LEGACY1', bestBefore: '2027-01-29', actor: A.actor });
    const h = await dl.hold({ code: 'MNGA-261101-01', reason: 'complaint' }, OWNER);
    eq([h.lot.status, h.lot.bake_date, h.lot.best_before, h.lot.hold_reason], ['hold', '2026-11-01', '2027-01-30', 'complaint'], 'hold on a ledger-only lot creates the row (bake date from the code)');
    eq((await st.lots()).filter((l) => l.lot_code === 'MNGA-261101-01').length, 1, 'one row created');
    try { await dl.hold({ code: 'LEGACY1', reason: 'x' }, OWNER); ok(false, 'ledger-only ambiguity did not throw'); } catch (e) { ok(e.status === 409 && e.extra.choose.length === 2, 'ledger-only code on two flavours asks to choose'); }
    const h2 = await dl.hold({ code: 'LEGACY1', slug: 'atta-ajwain', reason: 'x' }, OWNER);
    eq([h2.lot.item_slug, h2.lot.bake_date, h2.lot.best_before], ['atta-ajwain', null, '2027-01-29'], 'ledger-only lot with an unparsable code: no bake date, earliest best before');
  }

  // fix round 1
  {
    // legacy (no delivery) lot: Hold -> Release writes no packaging rows
    const { st, dl, inv } = fresh();
    await stockPack(st, inv);
    await st.insertLots([{ item_slug: 'atta-kesari', lot_code: '15OCT26', bake_date: '2026-10-16', best_before: '2027-01-13', status: 'released' }]);
    await inv.receive({ slug: 'atta-kesari', received: 50, lot: '15OCT26', bestBefore: '2027-01-13', actor: A.actor });
    await dl.hold({ code: '15OCT26', reason: 'x' }, OWNER);
    // Final review I2 changed this release from staff (A) to the owner: only the owner releases a lot the owner put on hold
    const r = await dl.release({ code: '15OCT26', tasted: true, weightG: 300 }, OWNER);
    eq([st.mv.filter((m) => m.type === 'USE').length], [0], 'legacy lot: Hold -> Release writes no USE rows');
    // ledger-only lot created by findLot
    await inv.receive({ slug: 'atta-ajwain', received: 20, lot: 'MNGA-261101-01', bestBefore: '2027-01-30', actor: A.actor });
    await dl.hold({ code: 'MNGA-261101-01', reason: 'x' }, OWNER);
    const r2 = await dl.release({ code: 'MNGA-261101-01', tasted: true, weightG: 300 }, OWNER);   // I2: owner, as above
    eq([st.mv.filter((m) => m.type === 'USE').length], [0], 'ledger-only lot: Hold -> Release writes no USE rows');
  }
  {
    // a failed lot update then a retry: still no USE rows, and the retry releases
    const { st, dl, inv } = fresh();
    await stockPack(st, inv);
    await saveOne(dl, oneKesari(100, 2));
    const real = st.updateLot; let failed = false;
    st.updateLot = async (...a) => { if (!failed) { failed = true; throw new Error('db down'); } return real(...a); };
    try { await dl.release({ code: KES, tasted: true, weightG: 300 }, A); ok(false, 'first release should fail'); } catch (e) { ok(e.message === 'db down', 'first release fails'); }
    eq(useRows(st, KES).length, 0, 'no USE rows written before the failure');
    const r = await dl.release({ code: KES, tasted: true, weightG: 300 }, A);
    eq([useRows(st, KES).length, (await st.lots()).find((l) => l.lot_code === KES).status], [0, 'released'], 'retry releases and writes no USE rows');
  }
  {
    // a packaging item missing from the list no longer matters to Release
    const { st, dl } = fresh();
    await saveOne(dl, oneKesari(100, 0));
    const st2 = { ...st, item: async (s) => (s === 'label-stamp' ? null : st.item(s)) };
    const dl2 = makeDeliveries(st2, { now: () => NOW });
    const r = await dl2.release({ code: KES, tasted: true, weightG: 300 }, A);
    eq([r.warnings, r.lot.status, useRows(st, KES).length], [[], 'released', 0], 'a missing packaging item gives no warning; release still succeeds');
  }

  // Task 7: Broken while cartoning, Throw away expired, lot-aware take-outs
  {
    const PH2 = '2026/11/fedcba9876543210.jpg';
    const rel = async (dl, st, inv) => { await saveOne(dl, oneKesari(100, 0)); await dl.release({ code: KES, tasted: true, weightG: 300 }, A); };
    // on a released lot: DAMAGED, reason repack, that lot
    {
      const { st, dl, inv } = fresh();
      await rel(dl, st, inv);
      const r = await dl.brokenWhileCartoning({ code: KES, qty: 3, note: 'crushed', photo: PH2 }, A);
      const m = st.mv.filter((x) => x.type === 'DAMAGED');
      eq(m.map((x) => [x.qty, x.lot_code, x.reason, x.note, x.actor_email]), [[-3, KES, 'repack', 'Broken while cartoning: crushed. Photo: ' + PH2, 'staff@x.com']], 'cartoning breakage row');
      eq(r.onHand, 97, 'returns the lot on hand');
      await dl.brokenWhileCartoning({ code: KES, qty: 1 }, A);
      eq(st.mv.filter((x) => x.type === 'DAMAGED').pop().note, 'Broken while cartoning', 'bare note without text or photo');
      await rejects(dl.brokenWhileCartoning({ code: KES, qty: 1, photo: 'bad.jpg' }, A), /That photo did not upload\. Take it again\./, 'bad photo path', 400);
      await rejects(dl.brokenWhileCartoning({ code: KES, qty: 500 }, A), new RegExp('^Lot ' + KES + ' has only 96 boxes\\.$'), 'never spills to another lot');
      await rejects(dl.brokenWhileCartoning({ code: 'NOPE', qty: 1 }, A), /No lot with that code/, 'unknown lot', 404);
      eq(st.mv.filter((x) => x.type === 'DAMAGED').length, 2, 'refusals wrote nothing');
    }
    // held lot refused
    {
      const { st, dl } = fresh();
      await saveOne(dl, oneKesari(100, 0));
      await rejects(dl.brokenWhileCartoning({ code: KES, qty: 1 }, A), /Lot MNGK-261105-01 is on hold/, 'held lot refused', 409);
      eq(st.mv.filter((x) => x.type === 'DAMAGED').length, 0, 'nothing written for a held lot');
    }
    // shared code needs a flavour
    {
      const { st, dl, inv } = fresh();
      await st.insertLots([{ item_slug: 'atta-original', lot_code: '15OCT26', bake_date: '2026-10-16', best_before: '2027-01-13', status: 'released' }, { item_slug: 'atta-kesari', lot_code: '15OCT26', bake_date: '2026-10-16', best_before: '2027-01-13', status: 'released' }]);
      for (const s of ['atta-kesari', 'atta-original']) await inv.receive({ slug: s, received: 50, lot: '15OCT26', bestBefore: '2027-01-13', actor: A.actor });
      try { await dl.brokenWhileCartoning({ code: '15OCT26', qty: 1 }, A); ok(false, 'did not throw'); } catch (e) { ok(e.status === 409 && e.extra.choose.length === 2, 'shared code answers choose'); }
      await dl.brokenWhileCartoning({ code: '15OCT26', slug: 'atta-original', qty: 2 }, A);
      eq(st.mv.filter((x) => x.type === 'DAMAGED').map((x) => [x.item_slug, x.lot_code, x.reason]), [['atta-original', '15OCT26', 'repack']], 'slug picks the flavour');
    }
    // take(): reason rules
    {
      const { st, inv } = fresh();
      await inv.receive({ slug: 'atta-kesari', received: 10, lot: 'L1', bestBefore: '2027-01-13', actor: A.actor });
      await inv.take({ slug: 'atta-kesari', qty: 1, type: 'DAMAGED', note: 'x', reason: 'supplier', actor: A.actor });
      eq(st.mv.filter((x) => x.type === 'DAMAGED').map((x) => x.reason), ['supplier'], 'reason written on DAMAGED');
      await rejects(inv.take({ slug: 'atta-kesari', qty: 1, type: 'DAMAGED', note: 'x', reason: 'bogus', actor: A.actor }), /Choose why it was damaged: on the bus, at the bakery or while cartoning\./, 'bad reason');
      await rejects(inv.take({ slug: 'atta-kesari', qty: 1, type: 'SAMPLE', reason: 'transit', actor: A.actor }), /Choose why it was damaged/, 'reason only with DAMAGED');
      await inv.take({ slug: 'atta-kesari', qty: 1, type: 'DAMAGED', note: 'x', actor: A.actor });
      ok(st.mv.filter((x) => x.type === 'DAMAGED').pop().reason == null, 'no reason stays empty');
    }
    // sample skips an expired lot
    {
      const { st, inv } = fresh();
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'OLD', bake_date: '2026-08-01', best_before: '2026-11-06', status: 'released' }, { item_slug: 'atta-kesari', lot_code: 'NEW', bake_date: '2026-11-01', best_before: '2027-01-30', status: 'released' }]);
      await inv.receive({ slug: 'atta-kesari', received: 5, lot: 'OLD', bestBefore: '2026-11-06', actor: A.actor });
      await inv.receive({ slug: 'atta-kesari', received: 5, lot: 'NEW', bestBefore: '2027-01-30', actor: A.actor });
      await inv.take({ slug: 'atta-kesari', qty: 2, type: 'SAMPLE', actor: A.actor });
      eq(st.mv.filter((x) => x.type === 'SAMPLE').map((x) => [x.lot_code, x.qty]), [['NEW', -2]], 'sample comes from the fresh lot');
    }
    // throw away expired
    {
      const { st, dl, inv } = fresh();
      await st.insertLots([
        { item_slug: 'atta-kesari', lot_code: 'OLD', bake_date: '2026-08-01', best_before: '2026-11-06', status: 'released' },
        { item_slug: 'atta-kesari', lot_code: 'TODAY', bake_date: '2026-08-02', best_before: '2026-11-07', status: 'released' },
        { item_slug: 'atta-original', lot_code: 'GONE', bake_date: '2026-08-01', best_before: '2026-11-01', status: 'released' },
        { item_slug: 'atta-ajwain', lot_code: 'HELD', bake_date: '2026-08-01', best_before: '2026-11-01', status: 'hold' },
      ]);
      await inv.receive({ slug: 'atta-kesari', received: 5, lot: 'OLD', bestBefore: '2026-11-06', actor: A.actor });
      await inv.receive({ slug: 'atta-kesari', received: 3, lot: 'OLD', bestBefore: '2026-11-04', actor: A.actor });   // same lot on a second best-before line (lot row says 2026-11-06)
      await inv.receive({ slug: 'atta-kesari', received: 4, lot: 'TODAY', bestBefore: '2026-11-07', actor: A.actor });
      await inv.receive({ slug: 'atta-original', received: 6, lot: 'GONE', bestBefore: '2026-11-01', actor: A.actor });
      await inv.receive({ slug: 'atta-ajwain', received: 2, lot: 'HELD', bestBefore: '2026-11-01', actor: A.actor });
      await inv.receive({ slug: 'atta-lite-sugar', received: 9, lot: 'NOROW', bestBefore: '2026-10-01', actor: A.actor });   // legacy, ledger only, expired
      await inv.receive({ slug: 'atta-lite-sugar', received: 7, lot: 'UNDATED', actor: A.actor });
      // Final review I3 changed this setup: a biscuit count-up now names its lot, so the +7 with no lot is an old count-up line from before
      await st.insert([{ item_slug: 'atta-lite-sugar', qty: 7, type: 'COUNT_FIX', lot_code: null, best_before: null, note: 'found' }]);   // +7 with no lot
      await rejects(dl.throwExpired({}, A), /^Only the owner can throw away expired stock\.$/, 'staff refused', 403);
      eq(st.mv.filter((x) => x.type === 'EXPIRED').length, 0, 'staff wrote nothing');
      const r = await dl.throwExpired({ slug: 'atta-kesari' }, OWNER);
      eq(r.lines.map((l) => [l.code, l.qty]), [['OLD', 8]], 'only the asked flavour, on hand summed over both lines');
      const e = st.mv.filter((x) => x.type === 'EXPIRED');
      eq(e.map((x) => [x.item_slug, x.lot_code, x.qty, x.best_before, x.note, x.actor_email]), [['atta-kesari', 'OLD', -8, '2026-11-06', 'Thrown away after best before', 'owner@x.com']], 'one EXPIRED row');
      const r2 = await dl.throwExpired({}, OWNER);
      eq(r2.lines.map((l) => [l.code, l.qty]).sort(), [['GONE', 6], ['HELD', 2], ['NOROW', 9]], 'all flavours: today lot, undated and lot-less stay; a held expired lot is written off too');
      eq(await dl.throwExpired({}, OWNER), { lines: [] }, 'nothing left gives an empty list');
    }
  }

  // Task 8: Correct whole delivery (while on hold) and Fix lot
  {
    const HOUR = 3600000;
    const STAFF2 = { actor: { email: 'other@x.com', name: 'Other' }, isOwner: false };
    const age = (st, id, hours) => st.updateDelivery(id, { created_at: new Date(NOW - hours * HOUR).toISOString() });
    const sumLot = (st, code, slug) => st.mv.filter((m) => m.lot_code === code && (!slug || m.item_slug === slug)).reduce((a, m) => a + m.qty, 0);
    const four = (over) => input({ billNo: 'C' + (++n), rows: rowsOf(over || { 'atta-ajwain': { broken: 2, brokenReason: 'transit', brokenPhoto: PH } }) });

    // correct a hold delivery
    {
      const { st, dl, inv } = fresh();
      for (const s of SLUGS) await inv.receive({ slug: s, received: 7, lot: '15OCT26', bestBefore: '2027-01-13', actor: A.actor });
      const onHand = async () => (await st.byLot()).reduce((a, r) => a + r.qty, 0);
      const base = await onHand();
      const inp = four();
      const r = await dl.save(inp, A);
      ok((await onHand()) === base + 398, 'setup: 398 good boxes on hand after the save');
      await age(st, inp.id, 1);
      await rejects(dl.correctDelivery({ id: inp.id, reason: '  ' }, A), /^Add a reason\.$/, 'a reason is required', 400);
      await rejects(dl.correctDelivery({ id: 'nope', reason: 'x' }, A), /^No such delivery\.$/, 'unknown delivery', 404);
      const out = await dl.correctDelivery({ id: inp.id, reason: 'typed the wrong bake date' }, A);
      ok((await onHand()) === base, 'the corrected boxes leave on hand');
      for (const l of r.lots) ok(sumLot(st, l.code, l.slug) === 0, 'lot ' + l.code + ' is back to zero');
      const rev = st.mv.filter((m) => m.type === 'REVERSAL');
      ok(rev.length === 5 && rev.every((m) => m.reverses_id && m.note === 'typed the wrong bake date' && m.actor_email === 'staff@x.com'), 'one REVERSAL per delivery row (5), each pointing at its row, note = the reason');
      const orig = st.mv.filter((m) => m.delivery_id === inp.id && m.type !== 'REVERSAL');
      ok(orig.length === 5 && rev.every((m) => { const o = st.mv.find((x) => x.id === m.reverses_id); return o && o.qty === -m.qty && o.lot_code === m.lot_code && o.best_before === m.best_before && o.ref === m.ref; }), 'each reversal mirrors its row (same lot, best before, ref); the original rows are untouched');
      eq((await st.delivery(inp.id)).status, 'void', 'delivery is void');
      const mine = (await st.lots()).filter((l) => l.delivery_id === inp.id);
      ok(mine.length === 4 && mine.every((l) => l.status === 'void'), 'its four lots are void');
      ok(out.prefill && out.prefill.id === undefined && out.prefill.billNo === inp.billNo && out.prefill.rows.length === 4 && out.prefill.cartons === 10, 'prefill is the stored input without its id');
      await rejects(dl.correctDelivery({ id: inp.id, reason: 'again' }, OWNER), /^This delivery was already corrected\.$/, 'a second correction is refused', 409);
      eq(st.mv.filter((m) => m.type === 'REVERSAL').length, 5, 'no further reversals written');
    }
    // the bill and part can be saved again; the void one is ignored everywhere
    {
      const { dl } = fresh();
      const a = four(); await dl.save(a, A);
      await rejects(dl.save({ ...a, id: 'other-id' }, A), /already saved/, 'two live deliveries with one bill + part clash', 400);
      await dl.correctDelivery({ id: a.id, reason: 'redo' }, A);
      const again = await dl.save({ ...a, id: 'rcpt-redo', bakeDate: '2026-11-04' }, A);
      eq(again.delivery.part, 1, 'the corrected bill + part saves again as part 1');
      eq(again.lots.map((l) => l.code), ['MNGO-261104-01', 'MNGK-261104-01', 'MNGA-261104-01', 'MNGL-261104-01'], 'the re-save makes its own lots');
      await dl.correctDelivery({ id: 'rcpt-redo', reason: 'redo again' }, A);
      const r3 = await dl.save({ ...a, id: 'rcpt-same-bake', bakeDate: '2026-11-04' }, A);
      eq(r3.lots.map((l) => l.code), ['MNGO-261104-02', 'MNGK-261104-02', 'MNGA-261104-02', 'MNGL-261104-02'], 'codes of the voided lots are not reused (-02)');
      await rejects(dl.save({ ...a, id: 'rcpt-clash' }, A), /^Bill C\d+ part 1 is already saved \(.*\)\. Tap "Add part 2" if this is the rest\.$/, 'the clash message offers part 2 (void ones are not counted)', 400);
      const part2 = await dl.save({ ...a, id: 'rcpt-p2', addPart: true, bakeDate: '2026-11-05' }, A);
      eq(part2.delivery.part, 2, 'Add part gives 2 when the live one is part 1');
      // only void ones on the bill: Add part starts again at 1
      const { st: s2, dl: d2 } = fresh();
      const c = four(); await d2.save(c, A); await d2.correctDelivery({ id: c.id, reason: 'x' }, A);
      const ap = await d2.save({ ...c, id: 'rcpt-ap', addPart: true }, A);
      eq(ap.delivery.part, 1, 'Add part with only a void delivery on the bill gives part 1');
      await rejects(s2.saveDelivery({ d: { id: 'zz', bill_no: c.billNo, part: 1 }, lots: [], moves: [] }).catch((e) => { throw new StockError(e.message, 500); }), /stock_deliveries_bill_part_once/, 'two live deliveries still clash in the store');
      await s2.saveDelivery({ d: { id: 'zz2', bill_no: c.billNo, part: 1, status: 'void' }, lots: [], moves: [] }).then(() => ok(true, 'a void one never clashes'), (e) => ok(false, 'void clash ' + e.message));
    }
    // released lots are refused, even after Hold
    {
      const { st, dl } = fresh();
      const a = four(); const r = await dl.save(a, A);
      await dl.release({ code: r.lots[1].code, tasted: true, weightG: 300 }, A);
      await rejects(dl.correctDelivery({ id: a.id, reason: 'x' }, OWNER), /^Released lots cannot be corrected here\. Use Fix lot\.$/, 'correct after one lot was released is refused', 409);
      eq((await st.delivery(a.id)).status, 'received', 'nothing changed');
      eq(st.mv.filter((m) => m.type === 'REVERSAL').length, 0, 'no reversal written');
      await dl.hold({ code: r.lots[1].code, reason: 'back on hold' }, OWNER);
      await rejects(dl.correctDelivery({ id: a.id, reason: 'x' }, OWNER), /^Released lots cannot be corrected here\. Use Fix lot\.$/, 'back on hold but released once is still refused', 409);
    }
    // boxes already used
    {
      const { st, dl } = fresh();
      const a = four(); const r = await dl.save(a, A);
      await st.insert([{ item_slug: 'atta-kesari', qty: -1, type: 'SAMPLE', lot_code: r.lots[1].code, best_before: r.lots[1].bestBefore }]);
      await rejects(dl.correctDelivery({ id: a.id, reason: 'x' }, OWNER), /^Boxes from this delivery have already been used\. Correct it with Fix lot or a count instead\.$/, 'a row from outside the delivery on its lots refuses', 409);
      eq(st.mv.filter((m) => m.type === 'REVERSAL').length, 0, 'nothing reversed');
      // the same code on ANOTHER flavour is a different lot
      const f2 = fresh();
      const b = four(); const rb = await f2.dl.save(b, A);
      await f2.st.insert([{ item_slug: 'atta-original', qty: 5, type: 'RECEIVE', lot_code: rb.lots[1].code, best_before: '2027-01-01' }]);
      ok(!!(await f2.dl.correctDelivery({ id: b.id, reason: 'x' }, OWNER)).prefill, 'the same code on another flavour is not this delivery\'s lot');
    }
    // permissions and the 24 hour rule
    {
      const { st, dl } = fresh();
      const a = four(); await dl.save(a, A);
      await age(st, a.id, 2);
      await rejects(dl.correctDelivery({ id: a.id, reason: 'x' }, STAFF2), /^Only the person who saved this delivery, or the owner, can correct it\.$/, 'staff cannot correct someone else\'s delivery', 403);
      eq(st.mv.filter((m) => m.type === 'REVERSAL').length, 0, 'refused staff wrote nothing');
      await age(st, a.id, 25);
      await rejects(dl.correctDelivery({ id: a.id, reason: 'x' }, A), /^Only the owner can correct a delivery older than a day\.$/, 'the saver at 25 hours is refused', 403);
      ok(!!(await dl.correctDelivery({ id: a.id, reason: 'late fix' }, OWNER)).prefill, 'the owner can at 25 hours');
      const b = four(); await dl.save(b, A); await age(st, b.id, 23.5);
      ok(!!(await dl.correctDelivery({ id: b.id, reason: 'x' }, A)).prefill, 'the saver at 23.5 hours is allowed');
      const c = four(); await dl.save(c, A); await age(st, c.id, 3);
      ok(!!(await dl.correctDelivery({ id: c.id, reason: 'x' }, { actor: { email: 'STAFF@x.com' }, isOwner: false })).prefill, 'the saver is matched ignoring case');
    }
    // a retry after a partial failure does not double-reverse
    {
      const { st, dl, inv } = fresh();
      const a = four(); const r = await dl.save(a, A);
      const dmg = st.mv.find((m) => m.delivery_id === a.id && m.type === 'DAMAGED');
      // one row already reversed (as a half-finished earlier attempt would leave it). inv.reverse now refuses delivery lines, so the REVERSAL row is written to the store directly.
      await st.insert([{ item_slug: dmg.item_slug, qty: -dmg.qty, type: 'REVERSAL', lot_code: dmg.lot_code, best_before: dmg.best_before, ref: dmg.ref, note: 'manual', reverses_id: dmg.id, delivery_id: a.id }]);
      let boom = true; const flaky = { ...st, updateDelivery: async (...x) => { if (boom) { boom = false; throw new Error('db down'); } return st.updateDelivery(...x); } };
      const dl2 = makeDeliveries(flaky, { now: () => NOW });
      await dl2.correctDelivery({ id: a.id, reason: 'x' }, A).then(() => ok(false, 'flaky did not throw'), (e) => ok(/db down/.test(e.message), 'the first attempt fails part way'));
      ok(r.lots.every((l) => sumLot(st, l.code, l.slug) === 0), 'the reversals were already written');
      ok(!!(await dl2.correctDelivery({ id: a.id, reason: 'x' }, A)).prefill, 'the retry completes');
      eq(st.mv.filter((m) => m.type === 'REVERSAL').length, 5, 'five reversals in all (the hand one counted once): no double reverse');
      ok(r.lots.every((l) => sumLot(st, l.code, l.slug) === 0) && (await st.delivery(a.id)).status === 'void', 'every lot is at zero and the delivery is void');
    }

    // ---- Fix lot ----
    const total = async (st) => (await st.byLot()).reduce((a, r) => a + r.qty, 0);
    {
      const { st, dl } = fresh();
      const a = four(); const r = await dl.save(a, A);
      const K = r.lots.find((l) => l.slug === 'atta-kesari').code;
      eq(K, 'MNGK-261105-01', 'setup: Kesari lot');
      const t0 = await total(st);
      await rejects(dl.fixLot({ code: K, newBakeDate: '2026-11-04' }, A), /^Only the owner can fix a lot\.$/, 'staff cannot fix a lot', 403);
      await rejects(dl.fixLot({ code: K }, OWNER), /^Enter the new code or the new bake date\.$/, 'one of the two is required', 400);
      await rejects(dl.fixLot({ code: K, newBakeDate: '2026-02-30' }, OWNER), /real date/i, 'a made-up date is refused', 400);
      await rejects(dl.fixLot({ code: K, newBakeDate: '2026-11-08' }, OWNER), /cannot be in the future/i, 'after today (IST) is refused', 400);
      await rejects(dl.fixLot({ code: K, newCode: 'bad!code' }, OWNER), /lot can use/i, 'invalid code', 400);
      await rejects(dl.fixLot({ code: K, newCode: K }, OWNER), /different from the old one/i, 'same code', 400);
      await rejects(dl.fixLot({ code: K, newCode: 'MNGO-261105-02' }, OWNER), /different flavour/i, 'an MNG code with another flavour\'s letter', 400);
      await rejects(dl.fixLot({ code: 'NOPE-1', newBakeDate: '2026-11-04' }, OWNER), /^No lot with that code\.$/, 'unknown lot', 404);
      eq(st.mv.filter((m) => m.type === 'COUNT_FIX').length, 0, 'refusals wrote nothing');
      const out = await dl.fixLot({ code: K, newBakeDate: '2026-11-04' }, OWNER);
      eq([out.from, out.to, out.warning], [K, 'MNGK-261104-01', 'Stickers already printed carry the old code or date: reprint them.'], 'new bake date gives the next code and the warning');
      const lot = (await st.lots()).find((l) => l.item_slug === 'atta-kesari');
      eq([lot.lot_code, lot.bake_date, lot.best_before, lot.status, lot.delivery_id, lot.aliases], ['MNGK-261104-01', '2026-11-04', '2027-02-02', 'hold', a.id, [K]], 'the lot row: new code, bake date, best before; status kept; old code is an alias');
      const found = await st.lotsByCode(K);
      ok(found.length === 1 && found[0].lot_code === 'MNGK-261104-01', 'lotsByCode of the old code finds the lot');
      eq(await total(st), t0, 'total on hand is unchanged');
      const fx = st.mv.filter((m) => m.type === 'COUNT_FIX');
      eq(fx.map((m) => [m.item_slug, m.lot_code, m.qty, m.best_before, m.note]), [['atta-kesari', K, -100, '2027-02-03', 'Lot fixed MNGK-261105-01 to MNGK-261104-01'], ['atta-kesari', 'MNGK-261104-01', 100, '2027-02-02', 'Lot fixed MNGK-261105-01 to MNGK-261104-01']], 'a COUNT_FIX pair, out of the old code and best before, into the new');
      eq(sumLot(st, K, 'atta-kesari'), 0, 'the old code holds nothing now');
      await rejects(dl.fixLot({ code: 'MNGK-261104-01', newBakeDate: '2026-11-04' }, OWNER), /same as the current/i, 'the same bake date is refused', 400);
      // code alone: an MNG code sets the dates; a free code leaves them
      const out3 = await dl.fixLot({ code: K, newCode: 'MNGK-261103-01' }, OWNER);
      eq([out3.from, out3.to], ['MNGK-261104-01', 'MNGK-261103-01'], 'the old alias still opens the lot, and the fix moves it again');
      const l3 = (await st.lots()).find((l) => l.item_slug === 'atta-kesari');
      eq([l3.lot_code, l3.bake_date, l3.best_before, l3.aliases], ['MNGK-261103-01', '2026-11-03', '2027-02-01', [K, 'MNGK-261104-01']], 'an MNG code sets the bake date and best before; both old codes are aliases');
      const out4 = await dl.fixLot({ code: 'MNGK-261103-01', newCode: 'KESARI-A' }, OWNER);
      const l4 = (await st.lots()).find((l) => l.item_slug === 'atta-kesari');
      eq([out4.to, l4.lot_code, l4.bake_date, l4.best_before], ['KESARI-A', 'KESARI-A', '2026-11-03', '2027-02-01'], 'a free code leaves the dates alone');
      eq(await total(st), t0, 'total on hand still unchanged');
      eq(st.mv.filter((m) => m.type === 'COUNT_FIX').length, 6, 'three fixes, three pairs');
    }
    // Fix lot is retry-safe when the row update fails after the stock moved
    for (const mode of ['code', 'date']) {
      const { st, dl } = fresh();
      const a = four(); const r = await dl.save(a, A);
      const K = r.lots.find((l) => l.slug === 'atta-kesari').code;
      const t0 = await total(st);
      let boom = true; const flaky = { ...st, updateLot: async (...x) => { if (boom) { boom = false; throw new Error('db down'); } return st.updateLot(...x); } };
      const dl2 = makeDeliveries(flaky, { now: () => NOW });
      const args = mode === 'code' ? { code: K, newCode: 'MNGK-261104-01' } : { code: K, newBakeDate: '2026-11-04' };
      await dl2.fixLot(args, OWNER).then(() => ok(false, mode + ': flaky did not throw'), (e) => ok(/db down/.test(e.message), mode + ': first attempt fails on the row update'));
      const out = await dl2.fixLot(args, OWNER);
      eq(out.to, 'MNGK-261104-01', mode + ': the retry lands on the same code (not -02, not refused)');
      eq(st.mv.filter((m) => m.type === 'COUNT_FIX').length, 2, mode + ': one set of COUNT_FIX pairs');
      const l = (await st.lots()).find((x) => x.item_slug === 'atta-kesari');
      eq([l.lot_code, l.aliases, l.bake_date, l.best_before], ['MNGK-261104-01', [K], '2026-11-04', '2027-02-02'], mode + ': the row is on the new code');
      eq([sumLot(st, K, 'atta-kesari'), sumLot(st, 'MNGK-261104-01', 'atta-kesari'), await total(st) === t0], [0, 100, true], mode + ': nothing stranded, total unchanged');
      eq((await st.lots()).filter((x) => x.item_slug === 'atta-kesari').length, 1, mode + ': no extra lot row');
    }
    // renamed to its own alias: no duplicate; two best-before groups move in two pairs
    {
      const { st, dl, inv } = fresh();
      await st.insertLots([{ item_slug: 'atta-original', lot_code: '27OCT26', aliases: ['MNGO-261027-01'], bake_date: '2026-10-27', best_before: '2027-01-25', status: 'released' },
        { item_slug: 'atta-kesari', lot_code: '27OCT26', aliases: ['MNGK-261027-01'], bake_date: '2026-10-27', best_before: '2027-01-25', status: 'released' }]);
      await inv.receive({ slug: 'atta-original', received: 30, lot: '27OCT26', bestBefore: '2027-01-25', actor: A.actor });
      await inv.receive({ slug: 'atta-original', received: 5, lot: '27OCT26', bestBefore: '2027-01-26', actor: A.actor });
      await inv.receive({ slug: 'atta-kesari', received: 9, lot: '27OCT26', bestBefore: '2027-01-25', actor: A.actor });
      const t0 = await total(st);
      await rejects(dl.fixLot({ code: '27OCT26', newCode: 'MNGO-261027-01' }, OWNER), /choose/i, 'a shared legacy code needs the flavour (R5)', 409);
      const out = await dl.fixLot({ code: '27OCT26', slug: 'atta-original', newCode: 'MNGO-261027-01' }, OWNER);
      eq(out.to, 'MNGO-261027-01', 'renamed to its own alias');
      const lo = (await st.lots()).find((l) => l.item_slug === 'atta-original');
      eq([lo.lot_code, lo.aliases, lo.bake_date, lo.best_before], ['MNGO-261027-01', ['27OCT26'], '2026-10-27', '2027-01-25'], 'aliases are exactly [27OCT26]: the new code is not its own alias');
      eq((await st.lots()).find((l) => l.item_slug === 'atta-kesari').lot_code, '27OCT26', 'the other flavour is untouched');
      eq(st.mv.filter((m) => m.type === 'COUNT_FIX' && m.lot_code === 'MNGO-261027-01').map((m) => [m.qty, m.best_before]), [[30, '2027-01-25'], [5, '2027-01-25']], 'dates came from the code (27 Oct + 90): both groups land on the new best before');
      eq(sumLot(st, '27OCT26', 'atta-original'), 0, 'old code is empty for Original');
      eq(await total(st), t0, 'total unchanged');
    }
    // refusals on a code another lot uses
    {
      const { st, dl, inv } = fresh();
      await st.insertLots([{ item_slug: 'atta-original', lot_code: 'LOT-A', aliases: ['OLDA'], bake_date: '2026-10-01', best_before: '2026-12-30', status: 'released' }, { item_slug: 'atta-original', lot_code: 'LOT-B', bake_date: '2026-10-02', best_before: '2026-12-31', status: 'released' },
        { item_slug: 'atta-kesari', lot_code: 'LOT-K', status: 'released' }]);
      await inv.receive({ slug: 'atta-original', received: 4, lot: 'LOT-B', bestBefore: '2026-12-31', actor: A.actor });
      await inv.receive({ slug: 'atta-original', received: 3, lot: 'LEDGERONLY', bestBefore: '2026-12-31', actor: A.actor });
      await inv.receive({ slug: 'atta-original', received: 6, lot: 'LOT-A', bestBefore: '2026-12-30', actor: A.actor });
      const msg = /^That code is already used by another lot\.$/;
      await rejects(dl.fixLot({ code: 'LOT-A', newCode: 'LOT-B' }, OWNER), msg, 'a code another lot uses', 400);
      await rejects(dl.fixLot({ code: 'LOT-A', newCode: 'LEDGERONLY' }, OWNER), msg, 'a ledger-only lot\'s code', 400);
      await st.updateLot('atta-original', 'LOT-B', { aliases: ['OLDB'] });
      await rejects(dl.fixLot({ code: 'LOT-A', newCode: 'OLDB' }, OWNER), msg, 'another lot\'s alias', 400);
      eq(st.mv.filter((m) => m.type === 'COUNT_FIX').length, 0, 'nothing written for refused fixes');
      eq((await dl.fixLot({ code: 'LOT-A', newCode: 'LOT-K' }, OWNER)).to, 'LOT-K', 'the same code on another flavour is allowed');
      await dl.fixLot({ code: 'LOT-K', slug: 'atta-original', newCode: 'OLDA' }, OWNER);
      eq((await st.lots()).find((l) => l.item_slug === 'atta-original' && l.lot_code === 'OLDA').aliases, ['LOT-A', 'LOT-K'], 'a lot may take back its own old alias (OLDA leaves the list)');
    }
    // a ledger-only lot: the row is created, then fixed
    {
      const { st, dl, inv } = fresh();
      await inv.receive({ slug: 'atta-ajwain', received: 20, lot: 'MNGA-261101-01', bestBefore: '2027-01-30', actor: A.actor });
      const out = await dl.fixLot({ code: 'MNGA-261101-01', newBakeDate: '2026-11-02' }, OWNER);
      eq(out.to, 'MNGA-261102-01', 'ledger-only lot fixed by date');
      const lot = (await st.lots())[0];
      eq([lot.lot_code, lot.bake_date, lot.best_before, lot.status, lot.aliases], ['MNGA-261102-01', '2026-11-02', '2027-01-31', 'released', ['MNGA-261101-01']], 'the row was made, then fixed');
      eq(st.mv.filter((m) => m.type === 'COUNT_FIX').map((m) => [m.lot_code, m.qty, m.best_before]), [['MNGA-261101-01', -20, '2027-01-30'], ['MNGA-261102-01', 20, '2027-01-31']], 'pair moved the ledger stock');
      await inv.receive({ slug: 'atta-ajwain', received: 4, lot: 'MNGA-261103-01', bestBefore: '2027-02-01', actor: A.actor });
      await inv.receive({ slug: 'atta-ajwain', received: 4, lot: 'MNGA-261110-01', bestBefore: '2027-02-08', actor: A.actor });
      const o2 = await dl.fixLot({ code: 'MNGA-261110-01', newBakeDate: '2026-11-03' }, OWNER);
      eq(o2.to, 'MNGA-261103-02', 'the next number looks at the ledger as well as the lots');
    }
  }

  // ---- Task 9: Lots list, lot page, trace search, buyer list (read-only) ----
  {
    const { st, dl, inv } = fresh();
    const ORDERS = {
      'MNG-AAAA-1010': { order_id: 'MNG-AAAA-1010', customer_name: 'Asha Rao', customer_phone: '919810000001', delivery_address: { raw: 'Flat 1, Sector 5, Gurgaon, Haryana - 122001', city: 'Gurgaon' }, packed_at: '2026-11-06T08:00:00.000Z', items: [] },
      'MNG-BBBB-1010': { order_id: 'MNG-BBBB-1010', customer_name: 'Bob Buyer', customer_phone: '919810000002', delivery_address: { raw: '7 MG Road, Pune, Maharashtra - 411001', recipientName: 'Rita Receiver', recipientPhone: '919820000009' }, packed_at: '2026-11-06T09:00:00.000Z', items: [] },
      'MNG-CCCC-1010': { order_id: 'MNG-CCCC-1010', customer_name: '=HYPERLINK(1)', customer_phone: '+919810000003', delivery_address: { raw: 'x' }, packed_at: null, items: [] },
    };
    const calls = [];
    const db = { getOrdersByIds: async (ids) => { calls.push(ids.length); return ids.filter((i) => ORDERS[i]).map((i) => ORDERS[i]); } };
    const L = makeDeliveries(st, { now: () => NOW, db });
    st.setSetting('lots_from', '2026-10-30T00:00:00.000Z');
    // old stock: 15OCT26 on Original (ledger only) and Kesari (stock_lots row with an alias); lot-less rows from before lots began
    await inv.receive({ slug: 'atta-original', received: 50, lot: '15OCT26', bestBefore: '2027-01-13', actor: A.actor });
    await inv.receive({ slug: 'atta-kesari', received: 50, lot: '15OCT26', bestBefore: '2027-01-13', actor: A.actor });
    await st.insertLots([{ item_slug: 'atta-kesari', lot_code: '15OCT26', aliases: ['MNGK-261016-01'], bake_date: '2026-10-15', best_before: '2027-01-13', status: 'released' }]);
    await st.insert([{ item_slug: 'atta-ajwain', qty: 20, type: 'RECEIVE', lot_code: null }, { item_slug: 'atta-original', qty: 7, type: 'RECEIVE', lot_code: null }]);
    // the new delivery: Kesari only, 2 broken on the bus
    const rs = await dl.save(input({ invoiceRupees: 10000, rows: [{ slug: 'atta-kesari', invoiceBoxes: 100, counted: 100, broken: 2, brokenReason: 'transit', brokenPhoto: PH, diffReason: 'x', rateRupees: 100 }] }), A);
    const KC = rs.lots[0].code;
    eq(KC, 'MNGK-261105-01', 'new Kesari lot code');
    const ref = (o, t) => `${o}@${t}`;
    const T1 = '2026-11-06T08:00:00.000Z', T3 = '2026-11-06T20:00:00.000Z';
    const sale = (o, t, q, lot) => ({ item_slug: 'atta-kesari', qty: -q, type: 'SALE', lot_code: lot || KC, best_before: '2027-02-03', ref: ref(o, t) });
    await st.insert([sale('MNG-AAAA-1010', T1, 3), sale('MNG-BBBB-1010', '2026-11-06T09:00:00.000Z', 2), sale('MNG-CCCC-1010', T3, 1), sale('MNG-AAAA-1010', T1, 1, '15OCT26'), sale('MNG-DDDD-1010', T1, 2)]);
    await st.insert([{ item_slug: 'atta-kesari', qty: 2, type: 'SALE_UNDO', lot_code: KC, best_before: '2027-02-03', ref: ref('MNG-DDDD-1010', T1) }]);
    const mvx = (type, qty, extra) => ({ item_slug: 'atta-kesari', qty, type, lot_code: KC, best_before: '2027-02-03', ref: 'x', ...(extra || {}) });
    await st.insert([mvx('OFFLINE_SALE', -4), mvx('EVENT_SALE', -2), mvx('EXHIBITION', -3), mvx('EXHIBITION_RETURN', 1), mvx('GIFT', -1), mvx('GIFT', -1), mvx('SAMPLE', -1), mvx('DAMAGED', -1, { reason: 'repack' }), mvx('EXPIRED', -1), mvx('SUPPLIER_RETURN', -1), mvx('COUNT_FIX', 2)]);
    const giftId = st.mv.filter((m) => m.type === 'GIFT').slice(-1)[0].id;
    await st.insert([mvx('REVERSAL', 1, { reverses_id: giftId })]);

    // no function writes anything
    const before = JSON.stringify({ mv: st.mv, lots: await st.lots(), d: [await st.delivery(rs.delivery.id)] });
    const lp = await L.lotPage(KC);
    const lots0 = await L.listLots();
    await L.search('MNGK-261016-01'); await L.search('15OCT26'); await L.search('MNG-AAAA-1010'); await L.search('nothing'); await L.buyersCsv(KC);
    await rejects(L.lotPage('15OCT26'), /more than one flavour/, 'ambiguity throws before any write', 409);
    eq(JSON.stringify({ mv: st.mv, lots: await st.lots(), d: [await st.delivery(rs.delivery.id)] }), before, 'lot list, lot page, search and CSV write nothing');

    // lot page
    eq([lp.lot.code, lp.lot.slug, lp.lot.status, lp.lot.name], [KC, 'atta-kesari', 'hold', 'Atta Kesari'], 'lot header');
    eq(lp.dates, { bakeDate: '2026-11-05', bestBefore: '2027-02-03', lastShip: '2026-12-15', websiteStop: '2026-12-13', daysToStop: 36, daysToBestBefore: 88 }, 'dates and days left from the IST today');
    eq(lp.delivery && [lp.delivery.id, lp.delivery.billNo, lp.delivery.part, lp.delivery.arrivedOn, lp.delivery.photos, lp.delivery.supplierBatch, lp.delivery.savedBy], [rs.delivery.id, 'A000300', 1, '2026-11-07', [], null, 'Staff'], 'delivery block');
    const nums = lp.numbers;
    eq(nums, { received: 100, broken: 2, good: 98, onHand: 81, website: 6, offline: 4, fairs: 4, gifts: 1, samples: 1, damaged: 1, returned: 1, expired: 1, fixes: 2 }, 'numbers after a sale, an undo, a reversal and a count fix');
    eq(nums.received - nums.broken - nums.damaged - nums.website - nums.offline - nums.fairs - nums.gifts - nums.samples - nums.returned - nums.expired + nums.fixes, nums.onHand, 'the numbers balance');
    eq(lp.perGoodPaise, rs.lots[0].perGoodPaise, 'cost per good box');
    eq(lp.sticker, 'python3 make_stamp_labels.py --lot MNGK-261105-01 --qty kesari=81 --cols 3 --col-gap 0.7 --left 4.0 --small-mrp --pitch 17.84375 --head-shift 2 --test', 'sticker command');
    eq(lp.orders.map((o) => [o.orderId, o.name, o.phone, o.city, o.recipientName || '', o.recipientPhone || '', o.packedAt, o.boxes]), [
      ['MNG-AAAA-1010', 'Asha Rao', '919810000001', 'Gurgaon', '', '', '2026-11-06T08:00:00.000Z', 3],
      ['MNG-BBBB-1010', 'Bob Buyer', '919810000002', 'Pune', 'Rita Receiver', '919820000009', '2026-11-06T09:00:00.000Z', 2],
      ['MNG-CCCC-1010', '=HYPERLINK(1)', '+919810000003', '', '', '', '2026-11-06T20:00:00.000Z', 1]], 'orders on the lot (the undone order is not there; the order with no packed_at uses the time in its ref)');
    ok(calls.length >= 1 && calls.every((k) => k === 3), 'one lookup per page view, only the lot\'s own orders (got ' + calls + ')');

    // CSV
    const csv = await L.buyersCsv(KC);
    const lines = csv.split('\n');
    eq(lines[0], 'order_id,buyer_name,buyer_phone,city,recipient_name,recipient_phone,packed_on,boxes', 'CSV header');
    eq(lines[2], '"MNG-BBBB-1010","Bob Buyer","919810000002","Pune","Rita Receiver","919820000009","2026-11-06","2"', 'Review Focus 5: the gift row carries the recipient, the buyer stays the buyer');
    eq(lines[1], '"MNG-AAAA-1010","Asha Rao","919810000001","Gurgaon","","","2026-11-06","3"', 'plain row');
    eq(lines[3], '"MNG-CCCC-1010","\'=HYPERLINK(1)","\'+919810000003","","","","2026-11-07","1"', 'formula-looking cells get a leading quote; packed_on is the IST date');
    ORDERS['MNG-AAAA-1010'].customer_name = 'A "Q" Rao, Jr';
    eq((await L.buyersCsv(KC)).split('\n')[1].split(',')[1], '"A ""Q"" Rao', 'quotes are doubled');
    ORDERS['MNG-AAAA-1010'].customer_name = 'Asha Rao';
    await rejects(L.buyersCsv('15OCT26'), /more than one flavour/, 'CSV of a shared code needs the flavour', 409);
    eq((await L.buyersCsv('15OCT26', 'atta-kesari')).split('\n').length, 2, 'CSV of the legacy Kesari lot: header and Asha');

    // legacy lots
    const lo = await L.lotPage('15OCT26', 'atta-original');
    eq([lo.lot.status, lo.lot.legacy, lo.dates.bestBefore, lo.dates.bakeDate, lo.numbers.onHand, lo.sticker, lo.delivery, lo.orders], [null, true, '2027-01-13', null, 50, null, null, []], 'a ledger-only code shows as a legacy lot');
    await rejects(L.lotPage('15OCT26'), /^This code is on more than one flavour\. Choose one\.$/, 'ambiguous legacy code', 409);
    try { await L.lotPage('15oct26'); ok(false, 'lower case ambiguity did not throw'); } catch (e) { eq(e.extra && e.extra.choose, [{ code: '15OCT26', slug: 'atta-kesari', name: 'Atta Kesari' }, { code: '15OCT26', slug: 'atta-original', name: 'Atta Original' }], 'choose list (lower case input works)'); }
    await rejects(L.lotPage('NOPE-1'), /^No lot with that code\.$/, 'unknown code', 404);
    await rejects(L.lotPage('MNGK-261105-01', 'atta-original'), /^No lot with that code\.$/, 'right code, wrong flavour', 404);

    // alias and search
    eq((await L.lotPage('MNGK-261016-01')).lot.code, '15OCT26', 'lot page by alias');
    eq(await L.search('mngk-261016-01 '), { lot: { code: '15OCT26', slug: 'atta-kesari' } }, 'search by alias (trimmed, any case)');
    eq(await L.search(KC), { lot: { code: KC, slug: 'atta-kesari' } }, 'search by our code');
    const ch = await L.search('15OCT26');
    eq(ch.choose && ch.choose.map((c) => c.slug).sort(), ['atta-kesari', 'atta-original'], 'search for a shared code asks which flavour');
    await st.updateLot('atta-kesari', KC, { supplier_batch: 'kb-77' });
    eq(await L.search('KB-77'), { lot: { code: KC, slug: 'atta-kesari' } }, 'search by Krazy Bakers batch');
    eq(await L.search('MNG-AAAA-1010'), { orderLots: [{ slug: 'atta-kesari', code: '15OCT26', boxes: 1 }, { slug: 'atta-kesari', code: KC, boxes: 3 }] }, 'search by order ID lists the lots of that order (alias mapped to the lot)');
    eq(await L.search('MNG-DDDD-1010'), { none: true }, 'an order whose packing was undone has no lots');
    eq(await L.search('MNG-ZZZZ-0000'), { none: true }, 'unknown order');
    eq(await L.search('nothing'), { none: true }, 'nothing found');
    eq(await L.search('   '), { none: true }, 'blank search');

    // list order: newest bake first, hold lot first, Untraced last
    const names = lots0.map((l) => [l.code, l.slug]);
    eq(names, [[KC, 'atta-kesari'], ['15OCT26', 'atta-kesari'], ['15OCT26', 'atta-original'], [null, null]], 'newest bake first, undated legacy after, Untraced last');
    // Task 12 changed this check: each entry also says its last ship date and whether a website order can still be packed from it
    // (released or legacy, and today on or before the last ship date), so Assign lot can offer only the lots that can ship
    // Task 2 (search as you type) changed this check: each entry also carries the lot's aliases, so the Lots list cards can show the sticker code
    eq(lots0[0], { code: KC, slug: 'atta-kesari', name: 'Atta Kesari', status: 'hold', aliases: [], onHand: 81, bakeDate: '2026-11-05', bestBefore: '2027-02-03', websiteStop: '2026-12-13', daysToStop: 36, lastShip: '2026-12-15', canShip: false }, 'list entry fields');
    eq([lots0[1].canShip, lots0[1].lastShip, lots0[2].canShip, lots0[2].lastShip, lots0[3].canShip, lots0[3].lastShip], [true, '2026-11-24', true, '2026-11-24', false, null], 'released and legacy lots before their last ship date can ship; Untraced never');
    eq([lots0[1].status, lots0[1].onHand, lots0[2].status, lots0[2].onHand, lots0[2].websiteStop], ['released', 49, null, 50, '2026-11-22'], 'legacy entries (Kesari 50 less the pack of 1; Original from the ledger)');
    eq([lots0[3].name, lots0[3].onHand, lots0[3].status], ['Untraced (before 30 Oct 2026)', 27, null], 'Untraced entry sums the lot-less rows');

    // Fix lot keeps the buyers, the numbers and the alias search
    const fx = await dl.fixLot({ code: KC, newBakeDate: '2026-11-04' }, { actor: { email: 'o@x.com' }, isOwner: true });
    const KN = fx.to;
    eq(KN, 'MNGK-261104-01', 'lot fixed');
    const lp2 = await L.lotPage(KC);
    eq([lp2.lot.code, lp2.numbers.onHand, lp2.numbers.website, lp2.orders.length, lp2.dates.bakeDate], [KN, 81, 6, 3, '2026-11-04'], 'after Fix lot the old code finds the same lot with the same numbers and buyers');
    const n2 = lp2.numbers;
    eq(n2.received - n2.broken - n2.damaged - n2.website - n2.offline - n2.fairs - n2.gifts - n2.samples - n2.returned - n2.expired + n2.fixes, n2.onHand, 'numbers still balance after Fix lot');
    eq(await L.search('MNG-BBBB-1010'), { orderLots: [{ slug: 'atta-kesari', code: KN, boxes: 2 }] }, 'order search maps the old code to the fixed lot');
  }
  // Task 12: canShip in the lots list follows the packing rule (released or legacy, today on or before the last ship date)
  {
    const { st } = fresh(); const LR = require('../utils/lots');
    const L = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    await st.insertLots([
      { item_slug: 'atta-original', lot_code: 'MNGO-260920-01', bake_date: '2026-09-20', best_before: '2026-12-19', status: 'released' },   // last ship 30 Oct: past
      { item_slug: 'atta-original', lot_code: 'MNGO-260928-01', bake_date: '2026-09-28', best_before: '2026-12-27', status: 'released' },   // last ship 7 Nov: today
      { item_slug: 'atta-original', lot_code: 'MNGO-261101-01', bake_date: '2026-11-01', best_before: '2027-01-30', status: 'rejected' }]);
    await st.insert(['MNGO-260920-01', 'MNGO-260928-01', 'MNGO-261101-01'].map((c) => ({ item_slug: 'atta-original', qty: 5, type: 'RECEIVE', lot_code: c, best_before: LR.datesFor(LR.parseCode(c).bakeDate, LR.DEFAULTS).bestBefore, ref: 'b' })));
    const by = Object.fromEntries((await L.listLots()).filter((l) => l.code).map((l) => [l.code, [l.lastShip, l.canShip]]));
    eq(by, { 'MNGO-261101-01': ['2026-12-11', false], 'MNGO-260928-01': ['2026-11-07', true], 'MNGO-260920-01': ['2026-10-30', false] }, 'past its last ship date: no; on its last ship date: yes; rejected: no');
  }
  // Untraced: an undo of an old lot-less pack raises it back; a pack made after lots began (and its undo) stays out
  {
    const { st, dl } = fresh();
    const L = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    await st.insert([{ item_slug: 'atta-original', qty: 20, type: 'RECEIVE', lot_code: null }, { item_slug: 'atta-original', qty: -3, type: 'SALE', lot_code: null, ref: 'MNG-OLD1-1010@2026-10-20T08:00:00.000Z' }]);
    st.mv.forEach((m) => { m.created_at = '2026-10-20T08:00:00.000Z'; });
    st.setSetting('lots_from', '2026-10-30T00:00:00.000Z');
    const untraced = async () => (await L.listLots()).find((x) => x.code === null).onHand;
    eq(await untraced(), 17, 'old pack counted');
    await st.insert([{ item_slug: 'atta-original', qty: 3, type: 'SALE_UNDO', lot_code: null, ref: 'MNG-OLD1-1010@2026-10-20T08:00:00.000Z' }]);
    eq(await untraced(), 20, 'undo of an old pack (written after lots_from) raises Untraced back by its boxes');
    await st.insert([{ item_slug: 'atta-original', qty: -2, type: 'SALE', lot_code: null, ref: 'MNG-NEW1-1010@2026-11-06T08:00:00.000Z' }]);
    eq(await untraced(), 20, 'a lot-less pack after lots_from belongs to Needs attention, not Untraced');
    await st.insert([{ item_slug: 'atta-original', qty: 2, type: 'SALE_UNDO', lot_code: null, ref: 'MNG-NEW1-1010@2026-11-06T08:00:00.000Z' }]);
    eq(await untraced(), 20, 'and its undo stays out too');
  }
  // a lot with more than 500 buyers is looked up in chunks of 500
  {
    const { st, dl } = fresh();
    const sizes = [];
    const db = { getOrdersByIds: async (ids) => { sizes.push(ids.length); return ids.map((i) => ({ order_id: i, customer_name: 'B ' + i, customer_phone: '1', delivery_address: { raw: 'a, b, Delhi, Delhi - 110001' }, packed_at: '2026-11-06T08:00:00.000Z', items: [] })); } };
    const L = makeDeliveries(st, { now: () => NOW, db });
    await st.insertLots([{ item_slug: 'atta-original', lot_code: 'MNGO-261101-01', bake_date: '2026-11-01', best_before: '2027-01-30', status: 'released' }]);
    await st.insert([{ item_slug: 'atta-original', qty: 2000, type: 'RECEIVE', lot_code: 'MNGO-261101-01', best_before: '2027-01-30', ref: 'b' }]);
    const rows = [];
    for (let i = 0; i < 1100; i++) rows.push({ item_slug: 'atta-original', qty: -1, type: 'SALE', lot_code: 'MNGO-261101-01', best_before: '2027-01-30', ref: `MNG-A${String(i).padStart(3, '0')}-1010@2026-11-06T08:00:00.000Z` });
    await st.insert(rows);
    const p = await L.lotPage('MNGO-261101-01');
    eq([p.orders.length, sizes], [1100, [500, 500, 100]], '1100 buyers: three lookups of at most 500');
    eq(p.orders[0].city, 'Delhi', 'city guessed from the address');
  }

  // Task 10: the delivery page (read only)
  {
    const { st, dl } = fresh();
    const OWN = { actor: { email: 'owner@x.com', name: 'Owner' }, isOwner: true }, OTHER = { actor: { email: 'other@x.com', name: 'Other' }, isOwner: false };
    const inp = input({ rows: rowsOf({ 'atta-ajwain': { invoiceBoxes: 100, counted: 98, diffReason: 'short', broken: 2, brokenReason: 'transit', brokenPhoto: PH } }), photos: [PH], note: 'bus late' });
    const r = await dl.save(inp, A);
    const mv = st.mv.length, lotsBefore = JSON.stringify(await st.lots());
    const pg = await dl.deliveryPage(inp.id, A);
    eq([pg.delivery.id, pg.delivery.billNo, pg.delivery.part, pg.delivery.supplier, pg.delivery.arrivedOn, pg.delivery.cartons, pg.delivery.photos, pg.delivery.note, pg.delivery.status, pg.delivery.savedBy], [inp.id, 'A000300', 1, 'Krazy Bakers', '2026-11-07', 10, [PH], 'bus late', 'received', 'Staff'], 'delivery fields');
    ok(typeof pg.delivery.savedAt === 'string' && pg.delivery.savedAt.length > 10, 'savedAt is a time');
    eq(pg.lots.map((l) => l.code), r.lots.map((l) => l.code), 'its four lots, as they are now');
    const aj = pg.lots.find((l) => l.slug === 'atta-ajwain');
    eq([aj.status, aj.good, aj.onHand, aj.bakeDate, aj.bestBefore, aj.lastShip, aj.websiteStop, aj.name], ['hold', 96, 96, '2026-11-05', '2027-02-03', '2026-12-15', '2026-12-13', 'Atta Ajwain'], 'a lot row: status, good, on hand and dates');
    ok(aj.perGoodPaise > 0, 'cost per good box');
    eq(pg.toRaise, r.toRaise, 'toRaise from the stored result'); eq(pg.notes, r.notes, 'notes from the stored result');
    eq(pg.canCorrect, true, 'the saver may still correct it');
    eq((await dl.deliveryPage(inp.id, OTHER)).canCorrect, false, 'another staff member may not');
    eq((await dl.deliveryPage(inp.id, OWN)).canCorrect, true, 'the owner may');
    ok(st.mv.length === mv && JSON.stringify(await st.lots()) === lotsBefore, 'reading the page writes nothing');
    await rejects(dl.deliveryPage('nope', A), /^No such delivery\.$/, 'unknown delivery', 404);
    await dl.release({ code: r.lots[0].code, slug: r.lots[0].slug, tasted: true, weightG: 260 }, A);
    const rel = await dl.deliveryPage(inp.id, A);
    eq([rel.canCorrect, rel.lots.find((l) => l.slug === r.lots[0].slug).status], [false, 'released'], 'once a lot is released it cannot be corrected and shows released');
    const inp2 = input({ billNo: 'A000301' }); await dl.save(inp2, A); await dl.correctDelivery({ id: inp2.id, reason: 'redo' }, A);
    const v = await dl.deliveryPage(inp2.id, OWN);
    eq([v.delivery.status, v.canCorrect, v.lots.every((l) => l.status === 'void')], ['void', false, true], 'a corrected delivery shows void and cannot be corrected again');
    // Add another lot: two Kesari lots in one delivery each show their own good boxes
    const inp3 = input({ billNo: 'A000302', invoiceRupees: 20000, confirm: ['cost_jump'], rows: [{ slug: 'atta-kesari', invoiceBoxes: 100, counted: 100, rateRupees: 100 }, { slug: 'atta-kesari', invoiceBoxes: 100, counted: 90, diffReason: 'short', rateRupees: 100, bakeDate: '2026-11-06' }] });
    await dl.save(inp3, A);
    const two = await dl.deliveryPage(inp3.id, A);
    eq(two.lots.map((l) => [l.code.slice(0, 12), l.good]), [['MNGK-261105-', 100], ['MNGK-261106-', 90]], 'two lots of one flavour: each its own good boxes');
  }

  // Task 13: owner emails and the 8:00 summary lines (mailer stubbed: nothing is ever sent)
  {
    const sent = [];
    const mailer = { sendDeliveryEmail: async (a) => { sent.push(['delivery', a]); }, sendLotReleasedEmail: async (a) => { sent.push(['released', a]); } };
    const mk = (extra) => { const st = memStore('2026-10-16T00:00:00.000Z'); return { st, dl: makeDeliveries(st, { now: () => NOW, mailer, ...(extra || {}) }), inv: makeInventory(st, { now: () => NOW }) }; };
    const OWN = { actor: { email: 'owner@x.com', name: 'Owner' }, isOwner: true };
    const { st, dl } = mk();
    const inp = input({ billNo: 'A000244', rows: rowsOf({ 'atta-ajwain': { counted: 98, diffReason: 'short' } }), invoiceRupees: 39500, confirm: ['invoice_mismatch', 'no_freight', 'cost_jump', 'stop_soon', 'old_bake'] });
    const pv = await dl.save({ ...inp }, { ...A, preview: true });
    eq(sent.length, 0, 'preview sends no email');
    const r = await dl.save(inp, A); await dl.mailSettled();
    eq(sent.length, 1, 'a first save sends one email');
    const e = sent[0][1];
    eq([sent[0][0], e.delivery.billNo, e.lots.length, e.url], ['delivery', 'A000244', 4, 'https://admin.munchingo.com/admin#delivery=' + inp.id], 'delivery email args');
    ok(e.lots.every((l) => l.code && l.name && typeof l.good === 'number' && /^Rs [\d,]+\.\d\d$/.test(l.cost)), 'each lot row has code, name, good and a 2-decimal cost');
    eq(e.lots[0].name, 'Atta Original', 'lot name from the flavour');
    ok(Array.isArray(e.warnings) && Array.isArray(e.toRaise) && e.toRaise.length === 1 && e.toRaise[0].name === 'Atta Ajwain', 'warnings and the to-raise list (with flavour name) are passed');
    await dl.save(inp, A); await dl.mailSettled();
    eq(sent.length, 1, 'a resend sends none');
    // a mail failure is logged and never changes the result
    const bad = { sendDeliveryEmail: async () => { throw new Error('resend down'); }, sendLotReleasedEmail: async () => { throw new Error('resend down'); } };
    const logs = []; const oe = console.error; console.error = (...a) => logs.push(a.join(' '));
    const f = mk({ mailer: bad });
    let fr; try { fr = await f.dl.save(input({ billNo: 'A000245' }), A); ok(true, 'save survives a mail failure'); } catch (x) { ok(false, 'save threw on a mail failure: ' + x.message); }
    ok(fr && fr.lots.length === 4 && (await f.st.lots()).filter((l) => l.delivery_id).length === 4, 'the delivery is still saved when the mail fails');
    let rr; try { rr = await f.dl.release({ code: fr.lots[0].code, tasted: true, weightG: 300 }, A); ok(rr.lot.status === 'released', 'release survives a mail failure'); } catch (x) { ok(false, 'release threw on a mail failure: ' + x.message); }
    await f.dl.mailSettled(); console.error = oe;
    ok(logs.filter((l) => /^\[MAIL\]/.test(l)).length === 2, 'both failures are logged with [MAIL] (got ' + JSON.stringify(logs) + ')');
    // release emails: staff sends one, owner none
    sent.length = 0;
    await dl.release({ code: r.lots[0].code, tasted: true, weightG: 275, note: 'crisp' }, A); await dl.mailSettled();
    eq(sent.length, 1, 'a staff release sends one email');
    eq([sent[0][0], sent[0][1].code, sent[0][1].name, sent[0][1].by, sent[0][1].weightG, sent[0][1].note, sent[0][1].url],
      ['released', r.lots[0].code, 'Atta Original', 'Staff', 275, 'crisp', 'https://admin.munchingo.com/admin#lot=' + encodeURIComponent(r.lots[0].code) + '&slug=atta-original'], 'release email args');
    await dl.release({ code: r.lots[1].code, tasted: true, weightG: 275 }, OWN); await dl.mailSettled();
    eq(sent.length, 1, 'an owner release sends none');
    await rejects(dl.release({ code: r.lots[1].code, tasted: true, weightG: 275 }, A), /already released/, 'a refused release still refused', 400);
    await dl.mailSettled(); eq(sent.length, 1, 'a refused release sends none');
    // a mailer that never answers must not hold the request up
    const hung = { sendDeliveryEmail: () => new Promise(() => {}), sendLotReleasedEmail: () => new Promise(() => {}) };
    const h = mk({ mailer: hung });
    const race = (p) => Promise.race([p, new Promise((res) => setTimeout(() => res('TIMEOUT'), 1500))]);
    const hr = await race(h.dl.save(input({ billNo: 'A000246' }), A));
    ok(hr !== 'TIMEOUT' && hr.lots && hr.lots.length === 4, 'save returns promptly with its normal result while the mailer never answers');
    const hrr = await race(h.dl.release({ code: hr.lots[0].code, tasted: true, weightG: 300 }, A));
    ok(hrr !== 'TIMEOUT' && hrr.lot && hrr.lot.status === 'released', 'release returns promptly while the mailer never answers');
  }
  // digestLines
  {
    const mk = () => { const st = memStore('2026-10-16T00:00:00.000Z'); return { st, dl: makeDeliveries(st, { now: () => Date.parse('2026-11-16T02:30:00Z') }), inv: makeInventory(st, { now: () => Date.parse('2026-11-16T02:30:00Z') }) }; };
    const { st, dl, inv } = mk();
    await st.insertLots([
      { item_slug: 'atta-kesari', lot_code: '15OCT26', bake_date: '2026-10-16', best_before: '2027-01-13', status: 'released' },                       // stop 22 Nov
      { item_slug: 'atta-original', lot_code: '15OCT26', bake_date: '2026-10-16', best_before: '2027-01-13', status: 'released' },                     // stop 22 Nov, nothing on hand
      { item_slug: 'atta-ajwain', lot_code: 'FAR', bake_date: '2026-11-01', best_before: '2027-01-30', status: 'released' },                          // stop 9 Dec: too far
      { item_slug: 'atta-lite-sugar', lot_code: 'GONE', bake_date: '2026-10-01', best_before: '2026-12-30', status: 'released' },                      // stop passed
      { item_slug: 'atta-kesari', lot_code: 'MNGK-261114-01', bake_date: '2026-11-14', best_before: '2027-02-12', status: 'hold', created_at: '2026-11-14T05:00:00.000Z' },
      { item_slug: 'atta-original', lot_code: 'MNGO-261115-01', bake_date: '2026-11-15', best_before: '2027-02-13', status: 'hold', created_at: '2026-11-15T05:00:00.000Z' },        // 21.5 h before the run: not yet
      { item_slug: 'atta-ajwain', lot_code: 'MNGA-261114-02', bake_date: '2026-11-14', best_before: '2027-02-12', status: 'hold', created_at: '2026-11-14T19:00:00.000Z' },          // 00:30 IST on the 15th, 31.5 h before the run: listed
    ]);
    await inv.receive({ slug: 'atta-kesari', received: 40, lot: '15OCT26', bestBefore: '2027-01-13', actor: A.actor });
    await inv.receive({ slug: 'atta-ajwain', received: 40, lot: 'FAR', bestBefore: '2027-01-30', actor: A.actor });
    await inv.receive({ slug: 'atta-lite-sugar', received: 40, lot: 'GONE', bestBefore: '2026-12-30', actor: A.actor });
    await inv.receive({ slug: 'atta-kesari', received: 100, lot: 'MNGK-261114-01', bestBefore: '2027-02-12', actor: A.actor });
    await inv.receive({ slug: 'atta-ajwain', received: 90, lot: 'MNGA-261114-02', bestBefore: '2027-02-12', actor: A.actor });
    const d = await dl.digestLines('2026-11-16');
    eq(d.stopSoon, [{ code: '15OCT26', name: 'Atta Kesari', websiteStop: '2026-11-22', onHand: 40 }], 'stop soon lists 15OCT26 only (not empty, far or past lots)');
    eq(d.onHold, [{ code: 'MNGK-261114-01', name: 'Atta Kesari', since: '2026-11-14', good: 100 }, { code: 'MNGA-261114-02', name: 'Atta Ajwain', since: '2026-11-15', good: 90 }], 'now() is 8:00 IST on the 16th: a lot saved 14 Nov and one saved 00:30 IST on the 15th are on hold; one saved 21.5 h earlier is not');
    const e2 = mk();
    eq(await e2.dl.digestLines('2026-11-16'), { onHold: [], stopSoon: [] }, 'nothing to report gives empty lists');
  }
  // the 8:00 summary HTML
  {
    const { dailySummaryHtml } = require('../utils/emailTemplates');
    const base = { dayLabel: 'Sun, 15 Nov 2026', orders: [] };
    const none = dailySummaryHtml({ ...base, stockLines: { onHold: [], stopSoon: [] } });
    ok(!/On hold for more than a day/.test(none) && !/Leaving the website within 7 days/.test(none), 'no stock sections when both lists are empty');
    ok(!/On hold for more than a day/.test(dailySummaryHtml(base)), 'no stockLines at all is fine');
    const hold = dailySummaryHtml({ ...base, stockLines: { onHold: [{ code: 'MNGK-261114-01', name: 'Atta <Kesari>', since: '2026-11-14', good: 100 }], stopSoon: [] } });
    ok(/On hold for more than a day/.test(hold) && /MNGK-261114-01/.test(hold) && /Atta &lt;Kesari&gt;/.test(hold) && /14 Nov/.test(hold) && !/Leaving the website within 7 days/.test(hold), 'on-hold section only, escaped');
    const stop = dailySummaryHtml({ ...base, stockLines: { onHold: [], stopSoon: [{ code: '15OCT26', name: 'Atta Kesari', websiteStop: '2026-11-22', onHand: 40 }] } });
    ok(/Leaving the website within 7 days/.test(stop) && /15OCT26/.test(stop) && /22 Nov/.test(stop) && /40/.test(stop) && !/On hold for more than a day/.test(stop), 'stop-soon section only');
  }
  // the mailer builders (Resend stubbed: never a real send)
  {
    const Module = require('module'); const sentMail = [];
    const origLoad = Module._load;
    Module._load = function (req, ...rest) { if (req === 'resend') return { Resend: class { constructor() { this.emails = { send: async (p) => { sentMail.push(p); return { error: null }; } }; } } }; return origLoad.call(this, req, ...rest); };
    delete require.cache[require.resolve('../utils/mailer')];
    process.env.NOTIFY_EMAIL = 'owner@example.test';
    const mailer = require('../utils/mailer');
    Module._load = origLoad;
    await mailer.sendDeliveryEmail({ delivery: { id: 'r1', billNo: 'A000244', part: 1 }, lots: [{ code: 'MNGK-261105-01', name: 'Atta <b>Kesari</b>', good: 98, cost: 'Rs 111.50' }, { code: 'MNGO-261105-01', name: 'Atta Original', good: 100, cost: 'Rs 98.47' }, { code: 'MNGA-261105-01', name: 'Atta Ajwain', good: 100, cost: 'Rs 98.47' }, { code: 'MNGL-261105-01', name: 'Atta Sugar-Lite', good: 100, cost: 'Rs 140.00' }], warnings: [{ key: 'x', text: 'Bad <script>' }], toRaise: [{ name: 'Atta Ajwain', invoice: 100, counted: 98 }], url: 'https://admin.munchingo.com/admin#delivery=r1' });
    const m = sentMail[0];
    eq([m.to, m.subject], [['owner@example.test'], 'New delivery on hold: bill A000244, 4 lots'], 'delivery email to the owner with the subject');
    ok(/MNGK-261105-01/.test(m.html) && /Rs 111\.50/.test(m.html) && /Bad &lt;script&gt;/.test(m.html) && !/<script>/.test(m.html) && /Atta &lt;b&gt;Kesari/.test(m.html) && /href="https:\/\/admin\.munchingo\.com\/admin#delivery=r1"/.test(m.html), 'delivery email body: rows, escaped warnings, link');
    await mailer.sendLotReleasedEmail({ code: 'MNGK-261105-01', name: 'Atta Kesari', by: 'Staff <x>', weightG: 275, note: 'crisp', url: 'https://admin.munchingo.com/admin#lot=MNGK-261105-01&slug=atta-kesari' });
    const m2 = sentMail[1];
    eq(m2.subject, 'Released by Staff <x>: MNGK-261105-01 (Atta Kesari)', 'release email subject');
    ok(/275/.test(m2.html) && /crisp/.test(m2.html) && /Staff &lt;x&gt;/.test(m2.html) && /href="https:\/\/admin\.munchingo\.com\/admin#lot=MNGK-261105-01&amp;slug=atta-kesari"/.test(m2.html), 'release email body: weight, note, escaped, link');
    await mailer.sendDailyDigestEmail({ orders: [], dayLabel: 'Sun, 15 Nov 2026', stockLines: { onHold: [{ code: 'C1', name: 'Atta Kesari', since: '2026-11-14', good: 5 }], stopSoon: [] } });
    ok(/On hold for more than a day/.test(sentMail[2].html), 'sendDailyDigestEmail passes stockLines through');
    delete require.cache[require.resolve('../utils/mailer')];
  }

  // ---- Final review C1: renamed and case-variant codes (the live ledger shapes), one lot per flavour, every lot action reaches it ----
  const OWN = { actor: { email: 'owner@x.com', name: 'Owner' }, isOwner: true };
  const tryIt = async (fn) => { try { return { r: await fn() }; } catch (e) { return { e }; } };
  {
    // Sugar-Lite: received as 15Oct26, renamed to 15OCT26 on 22 Oct with the old Rename lot (COUNT_FIX pair); 13 sold under the old spelling.
    // Rows as the backfill makes them (the shared mirror). The rename fold (owner's ruling) changed this block's expectations: 15Oct26 has
    // no lot of its own any more, it is an alias of 15OCT26, so both spellings open one lot with both buyers.
    const { st, dl, inv } = fresh();
    await st.insert([
      { item_slug: 'atta-lite-sugar', qty: 33, type: 'RECEIVE', lot_code: '15Oct26', best_before: '2027-01-12' },
      { item_slug: 'atta-lite-sugar', qty: -13, type: 'SALE', lot_code: '15Oct26', best_before: '2027-01-12', ref: 'MNG-SL01-1020@2026-10-20T05:00:00.000Z' },
      { item_slug: 'atta-lite-sugar', qty: -20, type: 'COUNT_FIX', lot_code: '15Oct26', best_before: '2027-01-12', note: 'Lot renamed 15Oct26 to 15OCT26' },
      { item_slug: 'atta-lite-sugar', qty: 20, type: 'COUNT_FIX', lot_code: '15OCT26', best_before: '2027-01-12', note: 'Lot renamed 15Oct26 to 15OCT26' },
      { item_slug: 'atta-lite-sugar', qty: -2, type: 'SALE', lot_code: '15OCT26', best_before: '2027-01-12', ref: 'MNG-SL02-1025@2026-10-25T05:00:00.000Z' },
      { item_slug: 'atta-kesari', qty: 40, type: 'RECEIVE', lot_code: '15OCT26', best_before: '2027-01-13' }]);
    await st.insertLots(backfillLots(st.mv));
    eq((await st.lots()).filter((l) => l.item_slug === 'atta-lite-sugar').map((l) => [l.lot_code, l.aliases]), [['15OCT26', ['MNGL-261016-01', '15Oct26']]], 'fold: the backfill makes one Sugar-Lite lot 1, 15Oct26 an alias');
    const dl2 = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async (ids) => ids.map((id) => ({ order_id: id, customer_name: 'Buyer ' + id.slice(4, 8), customer_phone: '919800000000', delivery_address: { city: 'Delhi' }, packed_at: null })) } });
    const lp = await tryIt(() => dl2.lotPage('15OCT26', 'atta-lite-sugar'));
    ok(lp.r && lp.r.lot.code === '15OCT26' && lp.r.lot.slug === 'atta-lite-sugar' && lp.r.numbers.onHand === 18 && lp.r.orders.map((o) => o.orderId).join() === 'MNG-SL01-1020,MNG-SL02-1025', 'C1 Sugar-Lite: lot page 15OCT26 opens its lot (18 on hand, both buyers) (' + (lp.e ? lp.e.message + ' ' + JSON.stringify(lp.e.extra) : JSON.stringify([lp.r.lot.code, lp.r.numbers.onHand, lp.r.orders.map((o) => o.orderId)])) + ')');
    const lo = await tryIt(() => dl2.lotPage('15Oct26', 'atta-lite-sugar'));
    ok(lo.r && lo.r.lot.code === '15OCT26' && lo.r.numbers.onHand === 18 && lo.r.orders.length === 2, 'C1 Sugar-Lite: the old spelling 15Oct26 opens the same lot, both buyers (' + (lo.e ? lo.e.message : lo.r.lot.code) + ')');
    const csv = await tryIt(() => dl2.buyersCsv('15OCT26', 'atta-lite-sugar'));
    ok(csv.r && csv.r.split('\n').length === 3 && /MNG-SL01-1020/.test(csv.r) && /MNG-SL02-1025/.test(csv.r), 'C1 Sugar-Lite: the buyer CSV of 15OCT26 lists both buyers (' + (csv.e ? csv.e.message : csv.r.split('\n').length + ' lines') + ')');
    for (const [q, want] of [['15OCT26', 'atta-kesari:15OCT26,atta-lite-sugar:15OCT26'], ['15Oct26', 'atta-kesari:15OCT26,atta-lite-sugar:15OCT26'], ['MNGL-261016-01', { code: '15OCT26', slug: 'atta-lite-sugar' }]]) {
      const s = await tryIt(() => dl2.search(q));
      if (typeof want !== 'string') eq(s.r && s.r.lot, want, 'C1 Sugar-Lite: search ' + q + ' opens one lot');
      else ok(s.r && Array.isArray(s.r.choose) && s.r.choose.map((c) => c.slug + ':' + c.code).sort().join() === want, 'C1: search ' + q + ' asks Kesari or Sugar-Lite, one entry each (' + JSON.stringify(s.r || s.e.message) + ')');
    }
    const pick2 = await tryIt(() => dl2.lotPage('15Oct26', 'atta-lite-sugar'));
    ok(pick2.r && pick2.r.lot.code === '15OCT26', 'C1: choosing Sugar-Lite from that list opens lot 15OCT26 (15Oct26 is its alias)');
    const fx = await tryIt(() => dl2.fixLot({ code: '15OCT26', slug: 'atta-lite-sugar', newCode: 'MNGL-261016-01' }, OWN));
    ok(fx.r && fx.r.from === '15OCT26' && fx.r.to === 'MNGL-261016-01', 'C1 Sugar-Lite: Fix lot 15OCT26 -> MNGL-261016-01 works (' + (fx.e ? fx.e.message + ' ' + JSON.stringify(fx.e.extra) : JSON.stringify(fx.r)) + ')');
    const after = await tryIt(() => dl2.lotPage('MNGL-261016-01', 'atta-lite-sugar'));
    ok(after.r && after.r.lot.code === 'MNGL-261016-01' && after.r.lot.aliases.includes('15OCT26') && after.r.lot.aliases.includes('15Oct26') && after.r.numbers.onHand === 18 && after.r.orders.length === 2, 'C1 Sugar-Lite: after Fix lot the lot page opens under the sticker code, both old codes aliases, 18 on hand, both buyers');
    const byOld = await tryIt(() => dl2.lotPage('15OCT26', 'atta-lite-sugar')), byOlder = await tryIt(() => dl2.lotPage('15Oct26', 'atta-lite-sugar'));
    ok(byOld.r && byOld.r.lot.code === 'MNGL-261016-01' && byOlder.r && byOlder.r.lot.code === 'MNGL-261016-01', 'C1 Sugar-Lite: both old codes still reach the fixed lot (' + (byOld.e ? byOld.e.message : byOld.r.lot.code) + ')');
    const sAfter = await dl2.search('15OCT26');
    ok(sAfter.choose && sAfter.choose.map((c) => c.slug + ':' + c.code).sort().join() === 'atta-kesari:15OCT26,atta-lite-sugar:MNGL-261016-01', 'C1: after Fix lot a search by the old shared code still lists both flavours, Sugar-Lite as its fixed lot (' + JSON.stringify(sAfter) + ')');
    const hd = await tryIt(() => dl2.hold({ code: '15OCT26', slug: 'atta-lite-sugar', reason: 'recall' }, OWN));
    ok(hd.r && hd.r.lot.lot_code === 'MNGL-261016-01' && hd.r.lot.status === 'hold', 'C1 Sugar-Lite: Hold by the old code holds the fixed lot');
    eq((await inv.sellable())['atta-lite-sugar'], 0, 'C1 Sugar-Lite: nothing sellable once the fixed lot is held');
  }
  {
    // Original lot 2: 27OCT26 renamed to its sticker code MNGO-261027-01 with the old Rename lot before the migration. The rename fold
    // (owner's ruling) changed this block: 27OCT26 gets no lot of its own and is an alias of MNGO-261027-01 (it used to be its own lot).
    const { st, inv } = fresh();
    await st.insert([
      { item_slug: 'atta-original', qty: 80, type: 'RECEIVE', lot_code: '27OCT26', best_before: '2027-01-25' },
      { item_slug: 'atta-original', qty: -80, type: 'COUNT_FIX', lot_code: '27OCT26', best_before: '2027-01-25', note: 'Lot renamed 27OCT26 to MNGO-261027-01' },
      { item_slug: 'atta-original', qty: 80, type: 'COUNT_FIX', lot_code: 'MNGO-261027-01', best_before: '2027-01-25', note: 'Lot renamed 27OCT26 to MNGO-261027-01' }]);
    await st.insertLots(backfillLots(st.mv));
    eq((await st.lots()).map((l) => [l.lot_code, l.aliases]), [['MNGO-261027-01', ['27OCT26']]], 'fold: one Original lot 2, 27OCT26 its alias');
    const dl2 = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    eq((await dl2.search('MNGO-261027-01')).lot, { code: 'MNGO-261027-01', slug: 'atta-original' }, 'C1 Original: search by the sticker code opens its lot');
    const a = await tryIt(() => dl2.lotPage('MNGO-261027-01', 'atta-original')), b = await tryIt(() => dl2.lotPage('27OCT26', 'atta-original'));
    ok(a.r && a.r.lot.code === 'MNGO-261027-01' && a.r.numbers.onHand === 80 && b.r && b.r.lot.code === 'MNGO-261027-01' && b.r.numbers.onHand === 80, 'C1 Original: both codes open the one lot (80 on hand)');
    const h = await tryIt(() => dl2.hold({ code: 'MNGO-261027-01', slug: 'atta-original', reason: 'recall' }, OWN));
    ok(h.r && h.r.lot.lot_code === 'MNGO-261027-01' && h.r.lot.status === 'hold', 'C1 Original: Hold works (' + (h.e ? h.e.message + ' ' + JSON.stringify(h.e.extra) : '') + ')');
    eq((await inv.sellable())['atta-original'], 0, 'C1 Original: the held lot leaves the website');
    const rl = await tryIt(() => dl2.release({ code: 'MNGO-261027-01', slug: 'atta-original', tasted: true, weightG: 260 }, OWN));
    ok(rl.r && rl.r.lot.status === 'released', 'C1 Original: Release works (' + (rl.e ? rl.e.message : '') + ')');
    const fx = await tryIt(() => dl2.fixLot({ code: 'MNGO-261027-01', slug: 'atta-original', newBakeDate: '2026-10-26' }, OWN));
    ok(fx.r && fx.r.to === 'MNGO-261026-01', 'C1 Original: Fix lot works (' + (fx.e ? fx.e.message : JSON.stringify(fx.r)) + ')');
    const br = await tryIt(() => dl2.brokenWhileCartoning({ code: 'MNGO-261026-01', slug: 'atta-original', qty: 1 }, OWN));
    ok(br.r && br.r.onHand === 79, 'C1 Original: Broken while cartoning works (' + (br.e ? br.e.message : JSON.stringify(br.r)) + ')');
  }
  {
    // the OLD backfill shape (27OCT26 with alias MNGO-261027-01 AND a MNGO-261027-01 row): the alias belongs to the row that owns the code
    const { st, inv } = fresh();
    await st.insert([
      { item_slug: 'atta-original', qty: 80, type: 'RECEIVE', lot_code: '27OCT26', best_before: '2027-01-25' },
      { item_slug: 'atta-original', qty: -80, type: 'COUNT_FIX', lot_code: '27OCT26', best_before: '2027-01-25', note: 'Lot renamed 27OCT26 to MNGO-261027-01' },
      { item_slug: 'atta-original', qty: 80, type: 'COUNT_FIX', lot_code: 'MNGO-261027-01', best_before: '2027-01-25', note: 'Lot renamed 27OCT26 to MNGO-261027-01' }]);
    await st.insertLots([
      { item_slug: 'atta-original', lot_code: '27OCT26', status: 'released', bake_date: '2026-10-27', best_before: '2027-01-25', aliases: ['MNGO-261027-01'] },
      { item_slug: 'atta-original', lot_code: 'MNGO-261027-01', status: 'released', bake_date: '2026-10-27', best_before: '2027-01-25', aliases: [] }]);
    const dl2 = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    const h = await tryIt(() => dl2.hold({ code: 'MNGO-261027-01', slug: 'atta-original', reason: 'recall' }, OWN));
    ok(h.r && h.r.lot.lot_code === 'MNGO-261027-01', 'C1 old shape: Hold by the sticker code holds the lot that owns it (' + (h.e ? h.e.message : '') + ')');
    const lst = (await dl2.listLots()).filter((l) => l.slug === 'atta-original').map((l) => l.code + ':' + l.onHand).sort();
    eq(lst, ['27OCT26:0', 'MNGO-261027-01:80'], 'C1 old shape: the Lots list never counts the 80 boxes twice');
    eq((await inv.sellable())['atta-original'], 0, 'C1 old shape: the hold takes the 80 boxes off the website');
  }

  // ---- Final review I2: staff release a new delivery, never a lot the owner put on hold (recall, complaint) ----
  {
    const { st, dl, inv } = fresh();
    const OWNER_HELD = 'This lot was put on hold by the owner. Only the owner can release it.';
    const r = await dl.save(input({ invoiceRupees: 10000, rows: [{ slug: 'atta-kesari', invoiceBoxes: 100, counted: 100, rateRupees: 100 }] }), A);
    const K = r.lots[0].code;
    const fresh1 = (await dl.listLots()).find((l) => l.code === K);
    ok(fresh1.status === 'hold' && !fresh1.ownerHold, 'I2: a new delivery is on hold, not held by the owner');
    eq((await dl.release({ code: K, tasted: true, weightG: 260 }, A)).lot.status, 'released', 'I2: staff release a new delivery');
    await dl.hold({ code: K, reason: 'Customer complaint: soft biscuits' }, OWN);
    await rejects(dl.release({ code: K, tasted: true, weightG: 260 }, A), new RegExp('^' + OWNER_HELD.replace(/\./g, '\\.') + '$'), 'I2: staff cannot release a lot the owner held after release', 403);
    eq((await inv.sellable())['atta-kesari'], 0, 'I2: and it stays off the website');
    const held = (await dl.listLots()).find((l) => l.code === K);
    eq([held.status, held.ownerHold, held.holdReason], ['hold', true, 'Customer complaint: soft biscuits'], 'I2: the Lots list marks it held by the owner, with the reason');
    const lp = await dl.lotPage(K);
    eq([lp.lot.status, lp.lot.ownerHold, lp.lot.holdReason], ['hold', true, 'Customer complaint: soft biscuits'], 'I2: the lot page too');
    const dp = await dl.deliveryPage(r.delivery.id, A);
    eq([dp.lots[0].status, dp.lots[0].ownerHold], ['hold', true], 'I2: and the delivery page');
    eq((await dl.release({ code: K, tasted: true, weightG: 262 }, OWN)).lot.status, 'released', 'I2: the owner releases it');
    // a backfilled lot (released by the migration, no released_at) held for a recall: still the owner's
    await st.insertLots([{ item_slug: 'atta-original', lot_code: '15OCT26', status: 'released', best_before: '2027-01-13', aliases: ['MNGO-261016-01'] }]);
    await st.insert([{ item_slug: 'atta-original', qty: 30, type: 'RECEIVE', lot_code: '15OCT26', best_before: '2027-01-13' }]);
    await dl.hold({ code: '15OCT26', slug: 'atta-original', reason: 'Krazy Bakers recall' }, OWN);
    await rejects(dl.release({ code: '15OCT26', slug: 'atta-original', tasted: true, weightG: 260 }, A), /^This lot was put on hold by the owner\. Only the owner can release it\.$/, 'I2: staff cannot release a backfilled lot the owner held', 403);
    ok((await dl.listLots()).find((l) => l.code === '15OCT26' && l.slug === 'atta-original').ownerHold === true, 'I2: the backfilled lot is listed as held by the owner');
    eq((await dl.listLots()).find((l) => l.code === '15OCT26' && l.slug === 'atta-original').aliases, ['MNGO-261016-01'], 'the Lots list rows carry the lot aliases (the sticker code shown on the lot card)');
    const k2 = await dl.save(input({ billNo: 'I2-2', invoiceRupees: 8500, rows: [{ slug: 'atta-ajwain', invoiceBoxes: 100, counted: 100, rateRupees: 85 }] }), A);
    ok(!('ownerHold' in (await dl.listLots()).find((l) => l.code === k2.lots[0].code)), 'I2: a new delivery on hold carries no ownerHold mark in the Lots list');
    const ov = (await inv.overview()).items.find((i) => i.slug === 'atta-original');
    ok(ov.lots.some((l) => l.lot_code === '15OCT26' && l.status === 'hold' && l.owner_hold === true), 'I2: the Stock screen lot line says held by the owner (' + JSON.stringify(ov.lots) + ')');
  }

  // ---- Rename fold (owner's ruling after the re-review): a code the old Rename lot emptied is an alias of the lot it went to, never a
  // lot of its own, so every read path lists every buyer of the lot and every write under the old code follows the lot's hold ----
  {
    const { computeSellable } = require('../utils/inventory');
    const { st, inv } = fresh();
    const SL = 'atta-lite-sugar', AJ = 'atta-ajwain', REN = 'Lot renamed 15Oct26 to 15OCT26', REN2 = 'Lot renamed 27OCT26 to MNGA-261027-01';
    // the live shapes: Sugar-Lite lot 1 received as 15Oct26 (13 sold, 4 to a fair, 1 gift), renamed to 15OCT26 on 22 Oct, 2 sold after;
    // Ajwain lot 2 renamed to its sticker code before the migration (1 buyer before, 1 after); Kesari and Original lot 1 untouched
    await st.insert([
      { item_slug: SL, qty: 33, type: 'RECEIVE', lot_code: '15Oct26', best_before: '2027-01-12' },
      { item_slug: SL, qty: -13, type: 'SALE', lot_code: '15Oct26', best_before: '2027-01-12', ref: 'MNG-SL01-1020@2026-10-20T05:00:00.000Z' },
      { item_slug: SL, qty: -4, type: 'EXHIBITION', lot_code: '15Oct26', best_before: '2027-01-12', ref: 'Diwali Mela' },
      { item_slug: SL, qty: -1, type: 'GIFT', lot_code: '15Oct26', best_before: '2027-01-12', ref: 'Mrs Sharma' },
      { item_slug: SL, qty: -15, type: 'COUNT_FIX', lot_code: '15Oct26', best_before: '2027-01-12', note: REN },
      { item_slug: SL, qty: 15, type: 'COUNT_FIX', lot_code: '15OCT26', best_before: '2027-01-12', note: REN },
      { item_slug: SL, qty: -2, type: 'SALE', lot_code: '15OCT26', best_before: '2027-01-12', ref: 'MNG-SL02-1025@2026-10-25T05:00:00.000Z' },
      { item_slug: 'atta-kesari', qty: 160, type: 'RECEIVE', lot_code: '15OCT26', best_before: '2027-01-13' },
      { item_slug: 'atta-original', qty: 100, type: 'RECEIVE', lot_code: '15OCT26', best_before: '2027-01-12' },
      { item_slug: AJ, qty: 90, type: 'RECEIVE', lot_code: '27OCT26', best_before: '2027-01-25' },
      { item_slug: AJ, qty: -10, type: 'SALE', lot_code: '27OCT26', best_before: '2027-01-25', ref: 'MNG-AJ01-1028@2026-10-28T05:00:00.000Z' },
      { item_slug: AJ, qty: -80, type: 'COUNT_FIX', lot_code: '27OCT26', best_before: '2027-01-25', note: REN2 },
      { item_slug: AJ, qty: 80, type: 'COUNT_FIX', lot_code: 'MNGA-261027-01', best_before: '2027-01-25', note: REN2 },
      { item_slug: AJ, qty: -3, type: 'SALE', lot_code: 'MNGA-261027-01', best_before: '2027-01-25', ref: 'MNG-AJ02-1101@2026-11-01T05:00:00.000Z' }]);
    const pre = computeSellable(await st.items(), await st.byLot(), await st.committed());   // before lots: every box counts
    await st.insertLots(backfillLots(st.mv));
    eq((await st.lots()).filter((l) => l.item_slug === SL || l.item_slug === AJ).map((l) => [l.item_slug, l.lot_code, l.aliases]),
      [['atta-ajwain', 'MNGA-261027-01', ['27OCT26']], ['atta-lite-sugar', '15OCT26', ['MNGL-261016-01', '15Oct26']]], 'fold: one lot each, the emptied code an alias');
    eq(await inv.sellable(), pre, 'fold: deploy-day sellable is identical to before lots');
    const BUYERS = 'MNG-SL01-1020,MNG-SL02-1025';
    const dl = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async (ids) => ids.map((id) => ({ order_id: id, customer_name: 'B ' + id, customer_phone: '91980', delivery_address: { city: 'Delhi' }, packed_at: null })) } });
    const buyersOf = async (code, slug) => { try { const p = await dl.lotPage(code, slug); return p.lot.code + ':' + p.orders.map((o) => o.orderId).join(); } catch (e) { return 'ERR ' + e.message; } };
    // the seven read paths
    const row = (await dl.listLots()).filter((l) => l.slug === SL);
    eq(row.map((l) => [l.code, l.onHand]), [['15OCT26', 13]], 'fold read 1: the Lots list has one Sugar-Lite lot 1 (15OCT26, all 13 boxes), no 15Oct26 row');
    eq(await buyersOf(row[0].code, SL), '15OCT26:' + BUYERS, 'fold read 1: and its lot page lists both buyers');
    const s1 = await dl.search('15OCT26'), c1 = (s1.choose || []).find((c) => c.slug === SL);
    eq([c1 && c1.code, c1 && await buyersOf(c1.code, SL)], ['15OCT26', '15OCT26:' + BUYERS], 'fold read 2: search 15OCT26, then Sugar-Lite: both buyers');
    const s2 = await dl.search('MNGL-261016-01');
    eq([s2.lot && s2.lot.code, s2.lot && await buyersOf(s2.lot.code, s2.lot.slug)], ['15OCT26', '15OCT26:' + BUYERS], 'fold read 3: search by the sticker code: both buyers');
    eq([await buyersOf('15oct26', SL), await buyersOf('15Oct26', SL)], ['15OCT26:' + BUYERS, '15OCT26:' + BUYERS], 'fold read 4: other spellings (15oct26, 15Oct26) open the same lot: both buyers');
    const csv = await dl.buyersCsv('15OCT26', SL);
    eq([csv.split('\n').length - 1, /MNG-SL01-1020/.test(csv) && /MNG-SL02-1025/.test(csv)], [2, true], 'fold read 5: Copy buyer list has both buyers (2 rows)');
    const dg = (await dl.digestLines('2026-11-15')).stopSoon.filter((l) => /Sugar-Lite/.test(l.name));
    eq([dg.map((l) => [l.code, l.onHand]), dg[0] && await buyersOf(dg[0].code, SL)], [[['15OCT26', 13]], '15OCT26:' + BUYERS], 'fold read 6: the 8:00 summary line (and its #lot= link code) is the one lot, 13 boxes, both buyers');
    eq([await buyersOf('27OCT26', AJ), await buyersOf('MNGA-261027-01', AJ)], ['MNGA-261027-01:MNG-AJ01-1028,MNG-AJ02-1101', 'MNGA-261027-01:MNG-AJ01-1028,MNG-AJ02-1101'], 'fold: lot 2 Ajwain, both codes, both buyers');
    // the write paths under the old code, while the lot is held for a recall
    await dl.hold({ code: '15OCT26', slug: SL, reason: 'Krazy Bakers recall' }, OWN);
    eq((await inv.sellable())[SL], 0, 'fold hold: Sugar-Lite off the website');
    await inv.eventReturn({ slug: SL, qty: 4, ref: 'Diwali Mela', actor: OWN.actor });
    ok(st.mv.slice(-1)[0].lot_code === '15Oct26', 'fold hold setup: the fair boxes come back under 15Oct26, where they left from');
    eq((await inv.sellable())[SL], 0, 'fold hold: the fair return adds 0 to the website');
    const plan = await inv.planForOrder({ items: [{ slug: SL, quantity: 2 }], at: new Date(NOW).toISOString() });
    ok(plan.rows.length === 0 && plan.short.length === 1, 'fold hold: packing takes none of them (' + JSON.stringify(plan.rows) + ')');
    const gift = st.mv.find((m) => m.type === 'GIFT' && m.lot_code === '15Oct26');
    await inv.reverse({ id: gift.id, reason: 'not given after all', actor: OWN.actor, isOwner: true });
    eq((await inv.sellable())[SL], 0, 'fold hold: the owner reversing a pre-rename line adds 0');
    await inv.restoreForOrder({ orderId: 'MNG-SL01-1020' });
    eq((await inv.sellable())[SL], 0, 'fold hold: undoing a pre-rename pack adds 0');
    ok(!(await dl.listLots()).some((l) => l.slug === SL && l.code === '15Oct26'), 'fold: the count-up lot picker (the Lots list) never offers 15Oct26');
    const have = (await inv.overview()).items.find((i) => i.slug === SL).on_hand;
    await inv.count({ slug: SL, counted: have + 1, note: 'found one', lot: '15Oct26', actor: OWN.actor });
    eq([st.mv.slice(-1)[0].lot_code, (await inv.sellable())[SL]], ['15OCT26', 0], 'fold: a count-up typed as 15Oct26 goes to lot 15OCT26 and stays held');
    await rejects(dl.release({ code: '15OCT26', slug: SL, tasted: true, weightG: 260 }, A), /^This lot was put on hold by the owner\. Only the owner can release it\.$/, 'fold: staff release of the owner-held lot is still refused', 403);
    // Fix lot (the owner chose not to for lot 1; the rule still holds): both old codes stay aliases, all buyers on one page
    const fx = await dl.fixLot({ code: '15OCT26', slug: SL, newCode: 'MNGL-261016-01' }, OWN);
    const fl = await dl.lotPage('MNGL-261016-01', SL);
    ok(fx.to === 'MNGL-261016-01' && fl.lot.aliases.includes('15OCT26') && fl.lot.aliases.includes('15Oct26') && fl.lot.status === 'hold' && fl.orders.map((o) => o.orderId).join() === 'MNG-SL02-1025' && fl.lot.aliases.length === 2, 'fold read 7: after a later Fix lot both old codes are aliases and the page is the one lot (' + JSON.stringify([fl.lot.aliases, fl.orders.map((o) => o.orderId)]) + ')');
    await rejects(dl.release({ code: 'MNGL-261016-01', slug: SL, tasted: true, weightG: 260 }, A), /put on hold by the owner/, 'fold: and after Fix lot staff still cannot release it', 403);
  }

  // ---- Partial-text search (owner, 9 Nov 2026): part of a code finds the lot; the exact answers stay as they were ----
  {
    const { st } = fresh();
    const SLP = 'atta-lite-sugar';
    const T = '2026-11-06T08:00:00.000Z';
    await st.insertLots([
      { item_slug: SLP, lot_code: '15OCT26', aliases: ['MNGL-261016-01', '15Oct26'], bake_date: '2026-10-16', best_before: '2027-01-14', status: 'released' },   // backfill-style
      { item_slug: 'atta-ajwain', lot_code: 'MNGA-261027-01', bake_date: '2026-10-27', best_before: '2027-01-25', status: 'released' },
      { item_slug: 'atta-ajwain', lot_code: 'MNGA-261101-01', bake_date: '2026-11-01', best_before: '2027-01-30', status: 'rejected' },
      { item_slug: 'atta-ajwain', lot_code: 'MNGA-260920-01', bake_date: '2026-09-20', best_before: '2026-12-19', status: 'hold' },
      { item_slug: 'atta-kesari', lot_code: 'MNGK-261105-01', bake_date: '2026-11-05', best_before: '2027-02-03', status: 'hold', supplier_batch: 'KB/OCT26/01' },
      { item_slug: 'atta-original', lot_code: 'MNGO-261101-01', bake_date: '2026-11-01', best_before: '2027-01-30', status: 'released', supplier_batch: 'kb/oct26/01' },
      { item_slug: 'atta-original', lot_code: 'MNGO-261027-01', bake_date: '2026-10-27', best_before: '2027-01-25', status: 'void' },
      { item_slug: 'atta-original', lot_code: 'MNGO-UNDATED', status: 'released' }]);
    const rec = (slug, code, qty, bb) => ({ item_slug: slug, qty, type: 'RECEIVE', lot_code: code, best_before: bb });
    const sale = (o, slug, code, q, type) => ({ item_slug: slug, qty: type === 'SALE_UNDO' ? q : -q, type: type || 'SALE', lot_code: code, best_before: '2027-01-30', ref: o + '@' + T });
    await st.insert([rec(SLP, '15OCT26', 20, '2027-01-14'), rec('atta-kesari', 'MNGK-261105-01', 10, '2027-02-03'), rec('atta-ajwain', 'MNGA-261027-01', 5, '2027-01-25'), rec('atta-original', 'MNGO-261101-01', 8, '2027-01-30'),
      sale('MNG-AAAA-1010', 'atta-kesari', 'MNGK-261105-01', 3), sale('MNG-AAAA-1010', SLP, '15Oct26', 1),
      sale('MNG-BBBB-1010', 'atta-ajwain', 'MNGA-261027-01', 2), sale('MNG-BBBB-1010', 'atta-ajwain', 'MNGA-261027-01', 2, 'SALE_UNDO'),   // packed, then undone
      sale('MNG-CCCC-1010', 'atta-original', null, 1)]);                                                                                      // lot-less: skipped
    const L = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    const snap = async () => JSON.stringify({ mv: st.mv, lots: await st.lots() });
    const before = await snap();
    const codes = (r) => (r.lots || []).map((c) => c.slug.replace('atta-', '') + ':' + c.code + (c.orderId ? '#' + c.orderId + 'x' + c.boxes : ''));

    // the owner's two searches
    for (const q of ['mngl', '261016', 'MNGL-2610', '  mngl261016  ']) {
      const r = await L.search(q);
      eq([codes(r), r.more], [['lite-sugar:15OCT26'], false], 'partial "' + q + '" finds Sugar-Lite lot 1 through its alias');
    }
    const lite = (await L.search('mngl')).lots[0];
    eq(lite, { code: '15OCT26', slug: SLP, name: 'Atta Sugar-Lite', status: 'released', onHand: 19, bakeDate: '2026-10-16', websiteStop: lite.websiteStop, daysToStop: lite.daysToStop, aliases: ['MNGL-261016-01', '15Oct26'], supplierBatch: null }, 'card fields');
    ok(lite.websiteStop && Number.isInteger(lite.daysToStop), 'card has the website stop and days to it');
    eq(codes(await L.search('mnga261027')), ['ajwain:MNGA-261027-01'], 'separator-stripped: mnga261027');
    eq(codes(await L.search('MNGA/261027')), ['ajwain:MNGA-261027-01'], 'a slash in the query is ignored too');
    eq(codes(await L.search('kboct26')).sort(), ['kesari:MNGK-261105-01', 'original:MNGO-261101-01'], 'supplier batch found as kboct26');
    eq(codes(await L.search('kb oct26')), ['original:MNGO-261101-01', 'kesari:MNGK-261105-01'], 'spaces ignored');
    // every status, empty and sold-out lots
    const all = await L.search('mng');
    eq(codes(all), ['original:MNGO-261101-01', 'original:MNGO-261027-01', 'original:MNGO-UNDATED', 'kesari:MNGK-261105-01', 'ajwain:MNGA-261101-01', 'ajwain:MNGA-261027-01', 'ajwain:MNGA-260920-01', SLP.replace('atta-', '') + ':15OCT26'], 'sorted by flavour (Original, Kesari, Ajwain, Sugar-Lite), bake date newest first, undated last');
    eq(all.lots.map((c) => [c.code, c.status, c.onHand]).filter((x) => ['MNGO-261027-01', 'MNGA-261101-01', 'MNGA-260920-01', 'MNGK-261105-01'].includes(x[0])), [['MNGO-261027-01', 'void', 0], ['MNGK-261105-01', 'hold', 7], ['MNGA-261101-01', 'rejected', 0], ['MNGA-260920-01', 'hold', 0]], 'void, held, rejected and empty lots are listed and marked');
    eq(all.lots.find((c) => c.code === 'MNGK-261105-01').supplierBatch, 'KB/OCT26/01', 'card carries the supplier batch');
    // partial order ID: lots reached only through the order, with that order's boxes
    for (const q of ['aaaa', 'mng aaaa', 'AAAA-1010', 'g-aaaa-1']) eq(codes(await L.search(q)), ['kesari:MNGK-261105-01#MNG-AAAA-1010x3', 'lite-sugar:15OCT26#MNG-AAAA-1010x1'], 'partial order ID "' + q + '" lists its lots with the order and its boxes');
    eq(await L.search('bbbb'), { none: true }, 'an order whose packing was undone has no lots');
    eq(await L.search('cccc'), { none: true }, 'a lot-less sale gives no lot');
    // 1 character
    // Task 2 (owner, 9 Nov): a search box that works from one character. These replace the "1 character gives nothing" checks.
    const m1 = await L.search('m'), m2 = await L.search('mn'), m4 = await L.search('mngl');
    ok(m1.lots.length > 0 && m1.more === true, '1 character gives a partial list of lots, and says more: true (the order read is skipped)');
    ok(m1.lots.length >= m2.lots.length && m2.lots.length >= m4.lots.length && m4.lots.length >= 1, 'm -> mn -> mngl narrows the list (' + [m1.lots.length, m2.lots.length, m4.lots.length] + ')');
    ok(m1.lots.some((c) => c.slug === SLP && c.code === '15OCT26') && m2.lots.some((c) => c.slug === SLP && c.code === '15OCT26') && m4.lots.some((c) => c.slug === SLP && c.code === '15OCT26'), 'the Sugar-Lite lot-1 card stays in the list at m, mn and mngl');
    eq([m4.more], [false], 'from 3 letters or digits the order read runs and the list can be complete');
    ok((await L.search('2')).lots.length > 0, '1 digit gives a partial list too');
    eq(await L.search('zz'), { lots: [], more: true }, 'no lot matches a short query: an empty list that still says to type more');
    eq(await L.search('---'), { none: true }, 'only separators: nothing to look for');
    // exact answers unchanged
    eq(await L.search('MNGK-261105-01'), { lot: { code: 'MNGK-261105-01', slug: 'atta-kesari' } }, 'exact code');
    eq(await L.search('mngk-261105-01'), { lot: { code: 'MNGK-261105-01', slug: 'atta-kesari' } }, 'exact code, any case');
    eq(await L.search('MNGL-261016-01'), { lot: { code: '15OCT26', slug: SLP } }, 'exact alias');
    eq(await L.search('MNG-AAAA-1010'), { orderLots: [{ slug: 'atta-kesari', code: 'MNGK-261105-01', boxes: 3 }, { slug: SLP, code: '15OCT26', boxes: 1 }] }, 'exact order ID');
    const two = await L.search('kb/oct26/01');
    eq([codes(two), two.more], [['original:MNGO-261101-01', 'kesari:MNGK-261105-01'], false], 'an exact supplier batch on two flavours gives the { lots } list');
    await st.updateLot('atta-original', 'MNGO-261101-01', { supplier_batch: 'KB/OCT26/09' });
    eq(await L.search('kb/oct26/01'), { lot: { code: 'MNGK-261105-01', slug: 'atta-kesari' } }, 'an exact supplier batch on one lot opens it');
    await st.updateLot('atta-original', 'MNGO-261101-01', { supplier_batch: 'kb/oct26/01' });
    eq(await L.search('   '), { none: true }, 'blank');
    eq(await snap(), before, 'search writes nothing');
  }
  {
    const { st } = fresh();
    await st.insertLots(Array.from({ length: 60 }, (_, i) => ({ item_slug: 'atta-original', lot_code: 'CAP-' + String(i + 1).padStart(3, '0'), status: 'released' })));
    const L = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    const r = await L.search('cap-');
    eq([r.lots.length, r.more, r.lots[0].code, r.lots[49].code], [50, true, 'CAP-001', 'CAP-050'], 'the list stops at 50 and says there is more');
    const r2 = await L.search('cap-05');
    eq([r2.lots.length, r2.more], [10, false], 'fewer than 50: no more');
    eq(await L.search('CAP-007'), { lot: { code: 'CAP-007', slug: 'atta-original' } }, 'a whole code stays exact even though it is also a substring');
  }

  // Ranking: matches at the start of the code, an alias, the supplier batch or the order ID (a part of a code after - / space, a part of an order ID only after "-") come first
  {
    const { st } = fresh();
    await st.insertLots([{ item_slug: 'atta-ajwain', lot_code: 'MNGA-261027-01', bake_date: '2026-10-27', best_before: '2027-01-25', status: 'released' },
      { item_slug: 'atta-lite-sugar', lot_code: '27OCT26', bake_date: '2026-10-27', best_before: '2027-01-25', status: 'released' },
      { item_slug: 'atta-original', lot_code: 'MNGO-261101-01', bake_date: '2026-11-01', best_before: '2027-01-30', status: 'released', supplier_batch: 'KB/27/OCT' }]);
    const L = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    const c = (r) => r.lots.map((x) => x.code);
    eq(c(await L.search('27')), ['MNGO-261101-01', '27OCT26', 'MNGA-261027-01'], 'typing 27: the two that start with 27 (a code, and a supplier batch part after a slash; flavour order inside the group) rank above MNGA-261027-01, which only contains it');
    eq(c(await L.search('261027')), ['MNGA-261027-01'], 'contains matching still finds MNGA-261027-01 for 261027 (a part after a hyphen starts with it)');
    eq(c(await L.search('6102')), ['MNGA-261027-01'], 'a mid-part match is still found (contains)');
    eq(c(await L.search('mnga')), ['MNGA-261027-01'], 'a prefix at the very start');
  }

  // Cost: one world read per search, and only the matching sale rows come back from the store
  {
    const { st } = fresh();
    await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261105-01', bake_date: '2026-11-05', best_before: '2027-02-03', status: 'released', supplier_batch: 'KB-1' },
      { item_slug: 'atta-original', lot_code: 'MNGO-261105-01', bake_date: '2026-11-05', best_before: '2027-02-03', status: 'released', supplier_batch: 'KB-1' }]);
    const T = '2026-11-06T08:00:00.000Z';
    await st.insert([{ item_slug: 'atta-kesari', qty: 10, type: 'RECEIVE', lot_code: 'MNGK-261105-01', best_before: '2027-02-03' },
      { item_slug: 'atta-kesari', qty: -2, type: 'SALE', lot_code: 'MNGK-261105-01', best_before: '2027-02-03', ref: 'MNG-AAAA-1010@' + T },
      { item_slug: 'atta-kesari', qty: -1, type: 'SALE', lot_code: 'MNGK-261105-01', best_before: '2027-02-03', ref: 'MNG-QQQQ-2020@2026-11-06T09:00:00.000Z' },
      { item_slug: 'atta-kesari', qty: 1, type: 'SALE_UNDO', lot_code: 'MNGK-261105-01', best_before: '2027-02-03', ref: 'MNG-QQQQ-2020@2026-11-06T09:00:00.000Z' }]);
    const counts = {};
    const wrapped = new Proxy(st, { get: (t, k) => (typeof t[k] === 'function' && k !== 'saleRowsMatching' ? (...a) => { counts[k] = (counts[k] || 0) + 1; return t[k](...a); } : t[k]) });
    const L = makeDeliveries(wrapped, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    const reset = () => { for (const k of Object.keys(counts)) delete counts[k]; st.saleCalls.length = 0; };
    const reads = () => [counts.lots || 0, counts.byLot || 0, counts.items || 0, counts.settingsAll || 0];
    reset(); await L.search('mngk');
    eq(reads(), [1, 1, 1, 1], 'a partial search reads lots, ledger, items and settings once each');
    reset(); await L.search('kb-1');
    eq([reads(), st.saleCalls.length], [[1, 1, 1, 1], 0], 'an exact supplier batch on two flavours: one world read and no sale read');
    reset(); await L.search('zzzz');
    eq([st.saleCalls.length, st.saleCalls[0] && st.saleCalls[0].n], [1, 0], 'a query that matches no order brings back zero sale rows');
    reset(); await L.search('aaaa');
    eq(st.saleCalls.map((x) => ({ q: x.q, n: x.n })), [{ q: 'AAAA', n: 1 }], 'only the matching order\'s rows come back (the other order is not read)');
    reset(); await L.search('QQQ');
    eq(st.saleCalls.map((x) => ({ q: x.q, n: x.n })), [{ q: 'QQQ', n: 2 }], 'a pack and its undo share a ref and both come back, so the undo rule still works (3 characters: the order read runs)');
    reset(); const q2 = await L.search('QQ');
    eq([st.saleCalls.length, q2.more], [0, true], 'under 3 letters or digits the order-ID read is skipped and the answer says more: true');
    eq(await L.search('qqqq'), { none: true }, 'the undone order gives no lot');
    eq([(await st.saleRowsMatching('MNG-AAAA')).rows.length, (await st.saleRowsMatching('MNGAAAA')).rows.length], [1, 0], 'order IDs keep their hyphens: MNG-AAAA matches, MNGAAAA does not');
    eq((await st.saleRowsMatching('2026')).rows.length, 0, 'the time after the @ is never matched');
  }

  // Order IDs match with their hyphens kept (9 Nov 2026, live check): "mngl" must not list lots only because an order MNG-LOSD-2010 drew from them
  {
    const { st } = fresh();
    const SLP = 'atta-lite-sugar', T = '2026-11-06T08:00:00.000Z';
    await st.insertLots([
      { item_slug: 'atta-original', lot_code: '15OCT26', bake_date: '2026-10-16', best_before: '2027-01-14', status: 'released' },
      { item_slug: 'atta-kesari', lot_code: '15OCT26', bake_date: '2026-10-16', best_before: '2027-01-14', status: 'released' },
      { item_slug: 'atta-ajwain', lot_code: '15OCT26', bake_date: '2026-10-16', best_before: '2027-01-14', status: 'released' },
      { item_slug: SLP, lot_code: '15OCT26', aliases: ['MNGL-261016-01'], bake_date: '2026-10-16', best_before: '2027-01-14', status: 'released' },
      { item_slug: SLP, lot_code: 'MNGL-261101-01', bake_date: '2026-11-01', best_before: '2027-01-30', status: 'released' },
      { item_slug: 'atta-kesari', lot_code: 'MNGK-261105-01', bake_date: '2026-11-05', best_before: '2027-02-03', status: 'released' }]);
    const sale = (o, slug, code, q) => ({ item_slug: slug, qty: -q, type: 'SALE', lot_code: code, best_before: '2027-01-14', ref: o + '@' + T });
    await st.insert([
      ...['atta-original', 'atta-kesari', 'atta-ajwain'].map((s2) => sale('MNG-LOSD-2010', s2, '15OCT26', 1)),
      sale('MNG-9WZ6-2910', 'atta-kesari', 'MNGK-261105-01', 2)]);
    const L = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    const codes = (r) => (r.lots || []).map((c) => c.slug.replace('atta-', '') + ':' + c.code + (c.orderId ? '#' + c.orderId : ''));
    const r = await L.search('mngl');
    eq(codes(r), ['lite-sugar:MNGL-261101-01', 'lite-sugar:15OCT26'], 'mngl lists only the Sugar-Lite lots: the MNG-LOSD-2010 order does not match');
    ok(!codes(r).some((c) => c.includes('MNG-LOSD-2010')), 'no card is there because of order MNG-LOSD-2010');
    eq(codes(await L.search('9wz6')), ['kesari:MNGK-261105-01#MNG-9WZ6-2910'], '9wz6 finds the order\'s lot');
    // any punctuation between the parts of an order ID counts as the hyphen (en dash, em dash, dot, underscore too)
    for (const q of ['mng\u20139wz6', 'mng\u20149wz6', '9wz6.2910', '9wz6_2910', 'mng.9wz6']) eq(codes(await L.search(q)), ['kesari:MNGK-261105-01#MNG-9WZ6-2910'], '"' + q + '" finds the order\'s lot');
    eq(await L.search('mng9wz62910'), { none: true }, 'mng9wz62910 (no separator at all) does not match');
    for (const q of ['9WZ6-29', 'mng-9wz6', 'mng 9wz6', 'mng/9wz6']) eq(codes(await L.search(q)), ['kesari:MNGK-261105-01#MNG-9WZ6-2910'], '"' + q + '" finds the order\'s lot');
    eq(await L.search('9wz62910'), { none: true }, 'the ID typed without its hyphen does not match');
    eq(codes(await L.search('mngk')).includes('kesari:MNGK-261105-01'), true, 'mngk still finds the lot by code');
    // starts-with ranking for an order: at the start of the ID or right after a hyphen, never inside a part
    const sorted = async (q) => { const x = await L.search(q); return x.lots; };
    await st.insertLots([{ item_slug: 'atta-original', lot_code: 'ZZ9WZ6X', bake_date: '2026-10-01', best_before: '2027-01-01', status: 'released' }]);
    await st.insertLots([{ item_slug: 'atta-original', lot_code: 'ZZWZ6Y', bake_date: '2026-10-01', best_before: '2027-01-01', status: 'released' }]);
    // 9wz6: the order card (starts a part) ranks before the contains-only lot ZZ9WZ6X even though Original sorts before Kesari
    eq(codes({ lots: await sorted('9wz6') }), ['kesari:MNGK-261105-01#MNG-9WZ6-2910', 'original:ZZ9WZ6X'], 'an order card ranks in the starts-with group for 9wz6');
    eq(codes({ lots: await sorted('2910') }), ['kesari:MNGK-261105-01#MNG-9WZ6-2910'], 'an order card for 2910 (a part after a hyphen)');
    await st.insertLots([{ item_slug: 'atta-original', lot_code: 'QQ2910Z', bake_date: '2026-10-01', best_before: '2027-01-01', status: 'released' }]);
    eq(codes({ lots: await sorted('2910') }), ['kesari:MNGK-261105-01#MNG-9WZ6-2910', 'original:QQ2910Z'], 'an order card ranks in the starts-with group for 2910');
    await st.insertLots([{ item_slug: 'atta-original', lot_code: 'QQWZ6Z', bake_date: '2026-10-01', best_before: '2027-01-01', status: 'released' }]);
    eq(codes({ lots: await sorted('wz6') }), ['original:QQWZ6Z', 'original:ZZ9WZ6X', 'original:ZZWZ6Y', 'kesari:MNGK-261105-01#MNG-9WZ6-2910'], 'an order card does not rank first for wz6 (it is inside a part); it comes after the Original lots by flavour order only')
    // mng and mng-: the shared prefix reads no orders and does not force more
    st.saleCalls.length = 0;
    for (const q of ['mng', 'MNG-', 'mng-']) { const x = await L.search(q); eq([st.saleCalls.length, x.more], [0, false], '"' + q + '" makes no order read and is not more'); }
    st.saleCalls.length = 0;
    await L.search('mng-9'); ok(st.saleCalls.length === 1, 'mng-9 reads orders');
    for (const q of ['9WZ6(', 'mng- 9wz6 ', '[9wz6]', '.*9wz6', '--9wz6--', '9wz6/ -']) await L.search(q);
    ok(st.saleCalls.every((x) => x.pattern === null || /^\^\[\^@\]\*[A-Z0-9-]+$/.test(x.pattern)), 'the pattern holds only A-Z, 0-9 and hyphen after ^[^@]* (' + JSON.stringify(st.saleCalls.map((x) => x.pattern)) + ')');
    ok(st.saleCalls.some((x) => x.pattern === '^[^@]*MNG-9WZ6'), 'mng- 9wz6 became MNG-9WZ6');
    ok(st.saleCalls.length > 0 && st.saleCalls.every((x) => /^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(x.q)), 'the string partial() passes to saleRowsMatching is letters and digits in hyphen-joined parts (' + JSON.stringify(st.saleCalls.map((x) => x.q)) + ')');
    st.saleCalls.length = 0;
    for (const q of ['mng\u2013', 'MNG.', 'mng\u2014']) { const x = await L.search(q); eq([st.saleCalls.length, x.more === true], [0, false], '"' + q + '" is only the prefix: no order read, and it does not force more'); }
    // the store itself keeps hyphens and does not strip them
    eq([(await st.saleRowsMatching('MNG-9WZ6')).rows.length, (await st.saleRowsMatching('MNG9WZ6')).rows.length, (await st.saleRowsMatching('2026')).rows.length], [1, 0, 0], 'the store: MNG-9WZ6 matches, MNG9WZ6 does not, the time after @ is never matched');
    // documentation only (not a Postgres test): the same two regexes in JS terms (JS equivalent; [^@] and a literal hyphen behave the same in both)
    ok(new RegExp('^[^@]*9WZ6-29', 'i').test('MNG-9WZ6-2910@x') && !new RegExp('^[^@]*MNGL', 'i').test('MNG-LOSD-2010@x'), 'regex check: 9WZ6-29 hits MNG-9WZ6-2910, MNGL misses MNG-LOSD-2010');
  }

  // Ranking: a lot's own code match lists before an order card in the same group (9 Nov 2026 review)
  {
    const { st } = fresh();
    const T = '2026-11-06T08:00:00.000Z';
    await st.insertLots([
      { item_slug: 'atta-original', lot_code: 'ORG-ONE', bake_date: '2026-10-16', best_before: '2027-01-14', status: 'released' },
      { item_slug: 'atta-kesari', lot_code: 'KES-ONE', bake_date: '2026-10-16', best_before: '2027-01-14', status: 'released' },
      { item_slug: 'atta-ajwain', lot_code: 'AJW-ONE', bake_date: '2026-10-16', best_before: '2027-01-14', status: 'released' },
      { item_slug: 'atta-lite-sugar', lot_code: 'MNGL-261105-01', bake_date: '2026-11-05', best_before: '2027-02-03', status: 'released' }]);
    const sale = (o, slug, code, q) => ({ item_slug: slug, qty: -q, type: 'SALE', lot_code: code, best_before: '2027-01-14', ref: o + '@' + T });
    await st.insert([['atta-original', 'ORG-ONE'], ['atta-kesari', 'KES-ONE'], ['atta-ajwain', 'AJW-ONE']].map(([s2, c2]) => sale('MNG-ABCD-2611', s2, c2, 1)).flat());
    const L = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    const r = await L.search('2611');
    const seq = (r.lots || []).map((c) => c.slug.replace('atta-', '') + ':' + c.code + (c.orderId ? '#' + c.orderId : ''));
    eq(seq, ['lite-sugar:MNGL-261105-01', 'original:ORG-ONE#MNG-ABCD-2611', 'kesari:KES-ONE#MNG-ABCD-2611', 'ajwain:AJW-ONE#MNG-ABCD-2611'], '2611: the lot whose own code matches lists before every order card');
  }

  // Typed text never breaks the pattern; a cut-off sale read never looks complete
  {
    const { st } = fresh();
    await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261105-01', bake_date: '2026-11-05', best_before: '2027-02-03', status: 'released' }]);
    const L = makeDeliveries(st, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    for (const q of ['9WZ6(', '[', '.*', 'a(b', '((', '\\', 'a)b', '+?', '$^', 'mn(g']) {
      const r = await tryIt(() => L.search(q));
      ok(r.r && (r.r.none === true || Array.isArray(r.r.lots)), 'typo "' + q + '" returns normally (' + (r.e ? r.e.message : JSON.stringify(r.r)) + ')');
    }
    ok(st.saleCalls.length > 0 && st.saleCalls.every((x) => x.pattern === null || /^\^\[\^@\]\*[A-Z0-9-]+$/.test(x.pattern)), 'every pattern sent to the store is upper-case letters, digits and hyphens only (' + JSON.stringify(st.saleCalls.map((x) => x.pattern)) + ')');
    ok(st.saleCalls.some((x) => x.pattern === '^[^@]*9WZ6'), '9WZ6( became 9WZ6');
    // more sale rows than the cap match: the answer says there is more
    for (let i = 0; i < 2001; i++) st.mv.push({ id: 100000 + i, item_slug: 'atta-kesari', qty: -1, type: 'SALE', lot_code: 'MNGK-261105-01', ref: 'MNG-X' + String(i).padStart(3, '0') + '-1010@2026-11-06T08:00:00.000Z', created_at: '2026-11-06T08:00:00.000Z' });
    const big = await st.saleRowsMatching('mng');
    eq([big.rows.length, big.capped], [2000, true], 'the store reads at most 2000 sale rows and says it was cut');
    const r = await L.search('mng-x');
    ok(r.more === true && Array.isArray(r.lots), 'a search whose sale read hit the cap says more: true (' + JSON.stringify([r.more, r.lots && r.lots.length]) + ')');
    const small = await L.search('mngk');
    eq(small.more, false, 'under the cap and under 50 lots: not more');
  }

  // Final review fixes (9 Nov 2026): a failed order read, no no-lot read on search, a clamped query
  {
    const { st } = fresh();
    await st.insertLots([{ item_slug: 'atta-lite-sugar', lot_code: 'MNGL-261105-01', bake_date: '2026-11-05', best_before: '2027-02-03', status: 'released' }]);
    await st.insert([{ item_slug: 'atta-lite-sugar', qty: 10, type: 'RECEIVE', lot_code: 'MNGL-261105-01', best_before: '2027-02-03' },
      { item_slug: 'atta-lite-sugar', qty: 2, type: 'COUNT_FIX', lot_code: null, best_before: null }]);   // a lot-less row, as on the live ledger
    const counts = {};
    const wrapped = new Proxy(st, { get: (t, k) => (k === 'saleRowsMatching' && t.failSales ? async () => { throw new Error('canceling statement due to statement timeout'); } : typeof t[k] === 'function' ? (...a) => { counts[k] = (counts[k] || 0) + 1; return t[k](...a); } : t[k]) });
    const L = makeDeliveries(wrapped, { now: () => NOW, db: { getOrdersByIds: async () => [] } });
    await L.search('mngl'); ok(!counts.lotlessSales, 'a search does not read the lot-less sales (it never shows that group) (' + counts.lotlessSales + ' reads)');
    ok((await L.listLots()).some((x) => x.code === null || x.noLot || x.code == null), 'the Lots list screen still builds the no-lot group');
    ok(counts.lotlessSales >= 1, 'the Lots list still reads the lot-less sales');
    st.failSales = true;
    const warns = []; const ow = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    const r = await tryIt(() => L.search('mngl'));
    console.warn = ow;
    ok(r.r && Array.isArray(r.r.lots) && r.r.lots.some((x) => x.code === 'MNGL-261105-01') && r.r.more === true, 'a failed order read does not fail the search: the lot card still comes back, more: true (' + (r.e ? r.e.message : JSON.stringify(r.r)) + ')');
    ok(warns.length === 1 && /^\[STOCK\] order search read failed: canceling statement due to statement timeout$/.test(warns[0]) && !/mngl/i.test(warns[0]), 'one warning line, the message only (' + JSON.stringify(warns) + ')');
    st.failSales = false;
    const long = await tryIt(() => L.search('mngl' + 'x'.repeat(5000)));
    ok(long.r && (long.r.none === true || Array.isArray(long.r.lots)) && !long.e, 'a 5,000-character query returns a normal answer (' + (long.e ? long.e.message : 'ok') + ')');
    const seen = []; const sp = st.saleRowsMatching; st.saleRowsMatching = async function (b, c) { seen.push(String(b).length); return sp.call(this, b, c); };
    await L.search('y'.repeat(5000)); ok(seen.every((n) => n <= 64), 'the query is cut to 64 characters before anything else (' + JSON.stringify(seen) + ')');
  }

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
