'use strict';
// Save one delivery (all flavours, lots on hold, every check, safe to resend).   node scripts/deliveries-test.js
const { makeDeliveries, PHOTO_PATH } = require('../utils/deliveries');
const { makeInventory, StockError } = require('../utils/inventory');
const { memStore } = require('./inventory-memstore');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ')');
const rejects = async (p, re, m, status) => { try { await p; ok(false, m + ' (did not throw)'); } catch (e) { ok(e instanceof StockError && re.test(e.message) && (!status || e.status === status), m + ' (got: ' + e.message + ' / ' + e.status + ')'); } };

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
    try { await dl.save(input({ bakeDate: '2026-10-25' }), A); } catch (e) { const w = e.extra.warnings.find((x) => x.key === 'old_bake'); ok(/Atta Original/.test(w.text) && /25 Oct/.test(w.text) && /13 days/.test(w.text) && /2 Dec/.test(w.text), 'old bake text names flavour, date, age and website stop: ' + w.text); }
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
    eq(await dl.lastPrefill(), { rates: RATES, freight: { busPerCarton: 0, delhiPerCarton: 0, porter: 0, other: 0 } }, 'prefill defaults');
    await dl.save(input({ billNo: 'P1', rows: [{ slug: 'atta-original', invoiceBoxes: 100, counted: 100, rateRupees: 88 }], invoiceRupees: 8800 }), A);
    const p = await dl.lastPrefill();
    eq([p.rates['atta-original'], p.rates['atta-kesari'], p.freight.busPerCarton, p.freight.porter], [88, 100, 150, 300], 'prefill from the last delivery, defaults for flavours it lacked');
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
    const r = await dl.release({ code: '15OCT26', tasted: true, weightG: 300 }, A);
    eq([st.mv.filter((m) => m.type === 'USE').length], [0], 'legacy lot: Hold -> Release writes no USE rows');
    // ledger-only lot created by findLot
    await inv.receive({ slug: 'atta-ajwain', received: 20, lot: 'MNGA-261101-01', bestBefore: '2027-01-30', actor: A.actor });
    await dl.hold({ code: 'MNGA-261101-01', reason: 'x' }, OWNER);
    const r2 = await dl.release({ code: 'MNGA-261101-01', tasted: true, weightG: 300 }, A);
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
      await inv.count({ slug: 'atta-lite-sugar', counted: 23, note: 'found', actor: A.actor });   // +7 with no lot
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

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
