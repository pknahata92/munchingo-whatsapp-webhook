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
  // prefill
  {
    const { dl } = fresh();
    eq(await dl.lastPrefill(), { rates: RATES, freight: { bus_per_carton: 0, delhi_per_carton: 0, porter: 0, other: 0 } }, 'prefill defaults');
    await dl.save(input({ billNo: 'P1', rows: [{ slug: 'atta-original', invoiceBoxes: 100, counted: 100, rateRupees: 88 }], invoiceRupees: 8800 }), A);
    const p = await dl.lastPrefill();
    eq([p.rates['atta-original'], p.rates['atta-kesari'], p.freight.bus_per_carton, p.freight.porter], [88, 100, 150, 300], 'prefill from the last delivery, defaults for flavours it lacked');
  }
  ok(PHOTO_PATH.test(PH) && !PHOTO_PATH.test('2026/11/xyz.jpg'), 'PHOTO_PATH');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
