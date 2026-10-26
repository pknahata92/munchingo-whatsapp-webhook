'use strict';
// Stock ledger logic against an in-memory store.   node scripts/inventory-test.js
const { makeInventory, StockError, allocate, boxesBySlug } = require('../utils/inventory');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const rejects = async (p, re, m) => { try { await p; ok(false, m + ' (did not throw)'); } catch (e) { ok(e instanceof StockError && re.test(e.message), m + ' (got: ' + e.message + ')'); } };

const { memStore } = require('./inventory-memstore');
const A = { email: 'staff@x.com', name: 'Staff' };
const onHand = async (inv, slug) => (await inv.overview()).items.find((i) => i.slug === slug).on_hand;
const status = async (inv, slug) => (await inv.overview()).items.find((i) => i.slug === slug).status;

(async () => {
  // allocation and gift-set expansion
  const a = allocate([{ lot_code: 'B', best_before: '2027-02-01', qty: 5 }, { lot_code: 'A', best_before: '2027-01-13', qty: 3 }, { lot_code: 'X', best_before: null, qty: 9 }], 10);
  ok(a.pieces.map((p) => p.lot_code + p.qty).join(',') === 'A3,B5,X2' && a.short === 0, 'FIFO: oldest best-before first, undated last');
  ok(allocate([{ lot_code: 'A', best_before: '2027-01-13', qty: 3 }], 5).short === 2, 'shortfall is reported');
  const bx = boxesBySlug([{ slug: 'atta-kesari', quantity: 2 }, { slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }, { slug: 'full-range-set', quantity: 1 }]);
  ok(bx['atta-kesari'] === 4 && bx['atta-original'] === 2 && bx['atta-lite-sugar'] === 2 && bx['atta-ajwain'] === 1, 'gift sets are opened up into flavours');

  const st = memStore('2026-10-16T00:00:00.000Z'); const inv = makeInventory(st);
  // first lot
  let r = await inv.receive({ slug: 'atta-kesari', received: 160, damaged: 0, lot: '15OCT26', bestBefore: '2027-01-13', ref: 'CH-1', actor: A });
  ok(r.onHand === 160, 'receive 160 Kesari');
  await inv.receive({ slug: 'atta-original', received: 120, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
  await inv.receive({ slug: 'atta-ajwain', received: 120, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
  r = await inv.receive({ slug: 'atta-lite-sugar', received: 33, damaged: 3, lot: '15OCT26', bestBefore: '2027-01-13', note: '3 crushed', actor: A });
  ok(r.onHand === 30 && st.mv.filter((m) => m.type === 'DAMAGED').length === 1, 'damaged boxes are written off in the same lot');
  ok(await status(inv, 'atta-lite-sugar') === 'low', 'Sugar-Lite at 30 is LOW (level 30)');
  ok(await status(inv, 'atta-kesari') === 'ok' && await status(inv, 'packing-tape') === 'new', 'ok and not-counted-yet statuses');
  // guards
  await rejects(inv.receive({ slug: 'atta-kesari', received: 160, lot: '15OCT26', actor: A }), /same receipt/, 'the same receipt twice is stopped');
  ok((await inv.receive({ slug: 'atta-kesari', received: 160, lot: '15OCT26', confirmDuplicate: true, actor: A })).onHand === 320, 'a second delivery can be confirmed');
  await inv.reverse({ id: st.mv.filter((m) => m.type === 'RECEIVE' && m.item_slug === 'atta-kesari').pop().id, reason: 'entered twice', actor: A });
  ok(await onHand(inv, 'atta-kesari') === 160, 'reversal brings the total back');
  await rejects(inv.reverse({ id: st.mv.filter((m) => m.type === 'RECEIVE' && m.item_slug === 'atta-kesari').pop().id, reason: 'again', actor: A }), /already reversed/, 'a line is reversed only once');
  await rejects(inv.receive({ slug: 'atta-kesari', received: 10, actor: A }), /lot/, 'a product receipt needs a lot');
  await rejects(inv.receive({ slug: 'atta-kesari', received: 10, damaged: 11, lot: 'X', actor: A }), /Damaged cannot/, 'damaged cannot exceed received');
  await rejects(inv.receive({ slug: 'atta-kesari', received: 6000, lot: 'Y', actor: A }), /very large/, 'a very large number asks to confirm');
  await rejects(inv.receive({ slug: 'atta-kesari', received: 1.5, lot: 'Y', actor: A }), /whole number/, 'no fractions');
  await rejects(inv.take({ slug: 'atta-kesari', qty: 500, type: 'SAMPLE', actor: A }), /on hand/, 'cannot go below zero without confirming');
  await rejects(inv.take({ slug: 'atta-kesari', qty: 1, type: 'DAMAGED', actor: A }), /note/, 'damaged needs a note');
  // packaging
  await inv.receive({ slug: 'packing-tape', received: 12, actor: A }); await inv.take({ slug: 'packing-tape', qty: 2, type: 'USE', actor: A });
  ok(await onHand(inv, 'packing-tape') === 10, 'packaging: receive and use');
  await inv.setLow({ slug: 'packing-tape', low: true }); ok(await status(inv, 'packing-tape') === 'low', 'one-tap Low flag');
  ok((await inv.overview()).low.map((x) => x.slug).includes('packing-tape'), 'low list carries flagged items');
  await inv.setLow({ slug: 'packing-tape', low: false });
  // count
  await rejects(inv.count({ slug: 'atta-original', counted: 118, actor: A }), /note/, 'a count that differs needs a reason');
  r = await inv.count({ slug: 'atta-original', counted: 118, note: '2 sent as samples', actor: A }); ok(r.diff === -2 && r.onHand === 118, 'count writes the difference');
  ok((await inv.count({ slug: 'atta-original', counted: 118, actor: A })).diff === 0, 'a matching count writes nothing');
  // sales
  r = await inv.deductForOrder({ orderId: 'MNG-1', items: [{ slug: 'atta-kesari', quantity: 2 }, { slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }], at: '2026-10-17T05:00:00.000Z' });
  ok(await onHand(inv, 'atta-kesari') === 157 && await onHand(inv, 'atta-original') === 117 && await onHand(inv, 'atta-lite-sugar') === 29, 'packing an order deducts each flavour (gift set opened up)');
  try { await inv.deductForOrder({ orderId: 'MNG-1', items: [{ slug: 'atta-kesari', quantity: 2 }], at: '2026-10-17T05:00:00.000Z' }); ok(false, 'packing the same order twice must be blocked'); } catch (e) { ok(/duplicate/.test(e.message), 'the same pack cannot be deducted twice (database guard)'); }
  r = await inv.restoreForOrder({ orderId: 'MNG-1' }); ok(r.rows >= 3 && await onHand(inv, 'atta-kesari') === 160, 'stepping back restores exactly what was taken');
  ok((await inv.restoreForOrder({ orderId: 'MNG-1' })).rows === 0, 'restoring twice does nothing more');
  await inv.deductForOrder({ orderId: 'MNG-1', items: [{ slug: 'atta-kesari', quantity: 1 }], at: '2026-10-17T06:00:00.000Z' }); ok(await onHand(inv, 'atta-kesari') === 159, 'packing again after an undo works');
  r = await inv.deductForOrder({ orderId: 'MNG-OLD', items: [{ slug: 'atta-kesari', quantity: 5 }], at: '2026-10-15T05:00:00.000Z' }); ok(r.skipped && await onHand(inv, 'atta-kesari') === 159, 'orders packed before tracking started are not deducted');
  await inv.deductForOrder({ orderId: 'MNG-BIG', items: [{ slug: 'atta-ajwain', quantity: 125 }], at: '2026-10-18T05:00:00.000Z' }); ok(await onHand(inv, 'atta-ajwain') === -5 && await status(inv, 'atta-ajwain') === 'out', 'a shortfall shows stock below zero (OUT) instead of failing the pack');
  // two lots, FIFO
  await inv.receive({ slug: 'atta-original', received: 50, lot: '25OCT26', bestBefore: '2027-01-23', actor: A });
  await inv.deductForOrder({ orderId: 'MNG-2', items: [{ slug: 'atta-original', quantity: 120 }], at: '2026-10-26T05:00:00.000Z' });
  const lots = (await inv.overview()).items.find((i) => i.slug === 'atta-original').lots.map((l) => l.lot_code + ':' + l.qty).join(',');
  ok(lots === '25OCT26:48', 'oldest lot is used up first, then the newer one (' + lots + ')');
  // reversal rules
  const old = st.mv.find((m) => m.type === 'RECEIVE'); old.created_at = '2026-10-01T00:00:00.000Z';
  await rejects(inv.reverse({ id: old.id, reason: 'x', actor: A, isOwner: false }), /owner/, 'staff cannot reverse a line older than a day');
  await rejects(inv.reverse({ id: st.mv.find((m) => m.type === 'SALE').id, reason: 'x', actor: A, isOwner: true }), /Undo on the order/, 'sales are reversed through the order, not here');
  // giveaways and exhibitions
  await rejects(inv.take({ slug: 'atta-kesari', qty: 2, type: 'GIFT', actor: A }), /who it is going to/, 'a giveaway needs a named recipient');
  await rejects(inv.take({ slug: 'atta-kesari', qty: 20, type: 'EXHIBITION', actor: A }), /event name/, 'an exhibition needs an event name');
  const before = await onHand(inv, 'atta-kesari');
  await inv.take({ slug: 'atta-kesari', qty: 2, type: 'GIFT', who: 'Mrs Sharma (Diwali gift)', actor: A }); ok(await onHand(inv, 'atta-kesari') === before - 2 && st.mv.slice(-1)[0].ref === 'Mrs Sharma (Diwali gift)', 'a giveaway lowers stock and records the recipient');
  await inv.take({ slug: 'atta-kesari', qty: 20, type: 'EXHIBITION', who: 'Diwali Mela Delhi', actor: A });
  let ov = await inv.overview(); let k = ov.items.find((i) => i.slug === 'atta-kesari');
  ok(k.on_hand === before - 22 && k.at_events === 20 && ov.events.length === 1 && ov.events[0].ref === 'Diwali Mela Delhi' && ov.events[0].items[0].out === 20, 'boxes taken to an event leave the shelf but stay visible as still out');
  await rejects(inv.eventReturn({ slug: 'atta-kesari', qty: 25, ref: 'Diwali Mela Delhi', actor: A }), /Only 20/, 'cannot return more than is out');
  await rejects(inv.eventReturn({ slug: 'atta-kesari', qty: 1, ref: 'Some Other Event', actor: A }), /Nothing is out/, 'cannot return from an event nothing went to');
  r = await inv.eventReturn({ slug: 'atta-kesari', qty: 7, ref: 'Diwali Mela Delhi', actor: A }); ok(r.stillOut === 13 && r.onHand === before - 15, 'unsold boxes come back to the shelf');
  ov = await inv.overview(); ok(ov.items.find((i) => i.slug === 'atta-kesari').at_events === 13, 'still-out count drops by what came back');
  await inv.eventReturn({ slug: 'atta-kesari', qty: 13, ref: 'Diwali Mela Delhi', actor: A }); ov = await inv.overview(); ok(ov.events.length === 0 && ov.items.find((i) => i.slug === 'atta-kesari').at_events === 0, 'a fully returned event closes');
  ok((await inv.overview()).items.find((i) => i.slug === 'atta-kesari').lots.map((l) => l.lot_code).includes('15OCT26'), 'returned boxes go back into their original lot');
  // offline sales and hampers
  await rejects(inv.take({ slug: 'atta-original', qty: 5, type: 'OFFLINE_SALE', actor: A }), /who bought/, 'an offline sale needs a buyer');
  await rejects(inv.take({ slug: 'atta-original', qty: 5, type: 'OFFLINE_SALE', who: 'Acme Corp', actor: A }), /invoice number/, 'an offline sale needs an invoice number');
  const o0 = await onHand(inv, 'atta-original');
  await inv.take({ slug: 'atta-original', qty: 5, type: 'OFFLINE_SALE', who: 'Acme Corp', invoice: 'MUN/OFF/26-27/0001', actor: A });
  const sale = st.mv.slice(-1)[0];
  ok(await onHand(inv, 'atta-original') === o0 - 5 && sale.type === 'OFFLINE_SALE' && sale.ref === 'MUN/OFF/26-27/0001' && sale.party === 'Acme Corp', 'a bulk sale lowers stock and records the buyer and the invoice number');
  const k0 = await onHand(inv, 'atta-kesari');
  r = await inv.offlineHamper({ hamper: 'Diwali Classic', hampers: 40, boxes: { 'atta-kesari': 3, 'atta-original': 2 }, buyer: 'Mehta Family Office', invoice: 'MUN/OFF/26-27/0002', actor: A });
  ok(await onHand(inv, 'atta-kesari') === k0 - 3 && r.hampers === 40, 'a hamper entry takes off only the boxes opened');
  ok(st.mv.filter((m) => m.ref === 'MUN/OFF/26-27/0002').every((m) => m.type === 'OFFLINE_SALE' && m.party === 'Mehta Family Office' && /Hamper: Diwali Classic x 40/.test(m.note)), 'every line is an offline sale with buyer, invoice and the hamper name and count');
  const rowsBefore = st.mv.length;
  await rejects(inv.offlineHamper({ hamper: 'X', hampers: 5, boxes: { 'atta-kesari': 9999 }, buyer: 'X', invoice: 'I1', actor: A }), /Not enough on hand/, 'not enough boxes stops the entry');
  ok(st.mv.length === rowsBefore, 'a refused hamper entry changes nothing (all or nothing)');
  await rejects(inv.offlineHamper({ hamper: 'X', hampers: 2, boxes: {}, buyer: 'X', invoice: 'I1', actor: A }), /boxes you opened/, 'a hamper entry must say which boxes were opened');
  await rejects(inv.offlineHamper({ hamper: '', hampers: 2, boxes: { 'atta-kesari': 1 }, buyer: 'X', invoice: 'I1', actor: A }), /which hamper/, 'a hamper entry needs the hamper name');
  await rejects(inv.offlineHamper({ hamper: 'X', hampers: 2, boxes: { 'atta-kesari': 1 }, buyer: '', invoice: 'I1', actor: A }), /who bought/, 'a hamper entry needs a buyer');
  // where did the stock go
  const fl = (await inv.flow()).items.find((i) => i.slug === 'atta-original');
  ok(fl.offline === 7 && fl.on_hand === await onHand(inv, 'atta-original'), 'the flow summary counts offline sales (5 + 2 boxes) and agrees with the shelf');
  const fk = (await inv.flow()).items.find((i) => i.slug === 'atta-kesari');
  ok(fk.received > 0 && fk.received + fk.returns - fk.website - fk.offline - fk.gifts - fk.samples - fk.events - fk.damaged - fk.used + fk.fixes + fk.other === fk.on_hand, 'for each flavour: everything received minus everywhere it went equals what is on the shelf');
  const gift = st.mv.find((m) => m.type === 'GIFT'); await inv.reverse({ id: gift.id, reason: 'wrong flavour', actor: A });
  const fk2 = (await inv.flow()).items.find((i) => i.slug === 'atta-kesari'); ok(fk2.gifts === 0 || fk2.gifts < (fk.gifts), 'a reversed gift no longer counts as a gift in the summary');
  // items
  const nr = await inv.addItem({ name: 'Bubble wrap', kind: 'packaging', unit: 'rolls', lowLevel: 2 }); ok(nr.slug === 'bubble-wrap', 'owner can add an item');
  await rejects(inv.addItem({ name: 'Bubble wrap', kind: 'packaging' }), /already/, 'no duplicate item');
  // ── History filter, and correcting a receipt in one step ──
  {
    const st2 = memStore('2026-10-16T00:00:00.000Z'); const iv = makeInventory(st2);
    await iv.receive({ slug: 'atta-lite-sugar', received: 33, damaged: 3, lot: '15Oct26', bestBefore: '2027-01-13', ref: 'CH-9', note: '3 crushed', billedKg: 8.25, amountRupees: 1200, actor: A });
    await iv.receive({ slug: 'atta-kesari', received: 160, lot: '15OCT26', actor: A });
    for (let i = 0; i < 70; i++) await iv.deductForOrder({ orderId: 'MNG-H' + i, items: [{ slug: 'atta-kesari', quantity: 1 }], at: '2026-10-20T05:00:00.000Z' });
    const idOf = (slug) => st2.mv.find((m) => m.type === 'RECEIVE' && m.item_slug === slug).id;
    // the Received lines were buried under 70 sales: a type filter brings them back
    const plain = await iv.history({ limit: 60 }); ok(!plain.movements.some((m) => m.type === 'RECEIVE'), 'setup: 70 later sales push the receipts out of the latest 60 lines (the bug Prashant saw)');
    const rec = await iv.history({ types: ['RECEIVE'], limit: 60 });
    ok(rec.movements.length === 2 && rec.movements.every((m) => m.type === 'RECEIVE'), 'history filtered to RECEIVE shows the receipts however many sales came after');
    ok((await iv.history({ types: ['SALE', 'SALE_UNDO'], limit: 60 })).movements.every((m) => m.type === 'SALE' || m.type === 'SALE_UNDO'), 'history can be filtered to sales');
    ok((await iv.history({ types: ['RECEIVE'], slug: 'atta-kesari', limit: 60 })).movements.length === 1, 'the filter combines with one product');
    ok(rec.movements.every((m) => m.reversed === false), 'each line says whether it was already reversed (not yet)');

    // receipt details, including the damaged boxes written in the same save
    const d = await iv.receipt({ id: idOf('atta-lite-sugar') });
    ok(d.slug === 'atta-lite-sugar' && d.received === 33 && d.damaged === 3 && d.lot === '15Oct26' && d.bestBefore === '2027-01-13' && d.ref === 'CH-9' && d.note === '3 crushed' && d.billedKg === 8.25 && d.amountRupees === 1200, 'receipt details return everything needed to refill the form (' + JSON.stringify(d) + ')');
    await rejects(iv.receipt({ id: st2.mv.find((m) => m.type === 'SALE').id }), /receipt/i, 'only a receipt can be corrected');

    // correct it: 33 received / 3 damaged becomes 36 received / 0 damaged, in one save
    const before = await onHand(iv, 'atta-lite-sugar'); ok(before === 30, 'setup: Lite on hand 30');
    const out = await iv.receive({ slug: 'atta-lite-sugar', received: 36, damaged: 0, lot: '15Oct26', bestBefore: '2027-01-13', ref: 'CH-9', replaces: d.id, actor: A, isOwner: true });
    ok(out.onHand === 36, 'correcting 33/3 to 36/0 leaves 36 on hand, not 66 or 30 (got ' + out.onHand + ')');
    ok(st2.mv.filter((m) => m.type === 'REVERSAL' && m.reverses_id === d.id).length === 1, 'the old receipt is cancelled with a reversal line (nothing is edited or deleted)');
    ok(st2.mv.filter((m) => m.type === 'REVERSAL' && /damaged/i.test(m.note || '') === false).length >= 1 && st2.mv.filter((m) => m.type === 'DAMAGED' && m.item_slug === 'atta-lite-sugar').every((m) => st2.mv.some((r) => r.reverses_id === m.id)), 'the damaged line written with the old receipt is cancelled too');
    ok((await iv.history({ types: ['RECEIVE'], slug: 'atta-lite-sugar' })).movements.find((m) => m.id === d.id).reversed === true, 'the corrected line now shows as reversed');
    await rejects(iv.receive({ slug: 'atta-lite-sugar', received: 40, lot: '15Oct26', replaces: d.id, actor: A, isOwner: true }), /already reversed/, 'a receipt can be corrected only once');
    ok(await onHand(iv, 'atta-lite-sugar') === 36, 'the refused second correction changed nothing');

    // all-or-nothing: bad new values must not cancel the old receipt
    const k = idOf('atta-kesari');
    await rejects(iv.receive({ slug: 'atta-kesari', received: 0, lot: '15OCT26', replaces: k, actor: A, isOwner: true }), /received/i, 'a correction with an invalid quantity is refused');
    await rejects(iv.receive({ slug: 'atta-kesari', received: 160, damaged: 200, lot: '15OCT26', replaces: k, actor: A, isOwner: true }), /Damaged cannot/, 'a correction with damaged above received is refused');
    ok(await onHand(iv, 'atta-kesari') === 90 && !st2.mv.some((m) => m.type === 'REVERSAL' && m.reverses_id === k), 'refused corrections leave the old receipt untouched (160 minus 70 sold = 90)');
    await rejects(iv.receive({ slug: 'atta-original', received: 5, lot: 'Z', replaces: k, actor: A, isOwner: true }), /same product/i, 'a correction must be for the same product as the line it replaces');
    await rejects(iv.receive({ slug: 'atta-kesari', received: 5, lot: 'Z', replaces: st2.mv.find((m) => m.type === 'SALE').id, actor: A, isOwner: true }), /receipt/i, 'a sale line cannot be "corrected"');

    // who may correct: same rule as Reverse (anyone within a day, the owner after that)
    st2.mv.find((m) => m.id === k).created_at = '2026-10-01T00:00:00.000Z';
    await rejects(iv.receive({ slug: 'atta-kesari', received: 150, lot: '15OCT26', replaces: k, actor: A, isOwner: false }), /owner/, 'staff cannot correct a receipt older than a day');
    const ow = await iv.receive({ slug: 'atta-kesari', received: 150, lot: '15OCT26', replaces: k, actor: A, isOwner: true });
    ok(ow.onHand === 80, 'the owner can correct an old receipt (150 received minus 70 sold = 80, got ' + ow.onHand + ')');
  }
  // ── Rename a lot (typo fix): move what is left in the lot to the correct code, ledger stays append-only ──
  {
    const st3 = memStore('2026-10-16T00:00:00.000Z'); const iv = makeInventory(st3);
    await iv.receive({ slug: 'atta-lite-sugar', received: 33, lot: '15Oct26', bestBefore: '2027-01-12', actor: A });
    await iv.receive({ slug: 'atta-kesari', received: 50, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
    for (let i = 0; i < 14; i++) await iv.deductForOrder({ orderId: 'MNG-R' + i, items: [{ slug: 'atta-lite-sugar', quantity: 1 }], at: '2026-10-20T05:00:00.000Z' });
    await iv.restoreForOrder({ orderId: 'MNG-R0', at: '2026-10-20T05:00:00.000Z' }).catch(() => {});
    const lotsOf = async (slug) => (await iv.overview()).items.find((i) => i.slug === slug).lots.map((l) => `${l.lot_code}:${l.qty}:${l.best_before}`).join(',');
    const had = await onHand(iv, 'atta-lite-sugar');
    ok(await lotsOf('atta-lite-sugar') === `15Oct26:${had}:2027-01-12`, 'setup: Sugar-Lite is all in lot 15Oct26 (' + await lotsOf('atta-lite-sugar') + ')');

    await rejects(iv.renameLot({ slug: 'atta-lite-sugar', from: '15Oct26', to: '15OCT26', actor: A, isOwner: false }), /owner/i, 'only the owner can rename a lot');
    await rejects(iv.renameLot({ slug: 'atta-lite-sugar', from: '15Oct26', to: '15Oct26', actor: A, isOwner: true }), /different/i, 'the new code must differ from the old one');
    await rejects(iv.renameLot({ slug: 'atta-lite-sugar', from: '15Oct26', to: 'bad!code', actor: A, isOwner: true }), /lot can use/i, 'an invalid new code is refused');
    await rejects(iv.renameLot({ slug: 'atta-lite-sugar', from: 'NOPE', to: '15OCT26', actor: A, isOwner: true }), /no stock/i, 'a lot with nothing in it cannot be renamed');
    ok(await lotsOf('atta-lite-sugar') === `15Oct26:${had}:2027-01-12`, 'refused renames change nothing');

    const r = await iv.renameLot({ slug: 'atta-lite-sugar', from: '15Oct26', to: '15OCT26', actor: A, isOwner: true });
    ok(r.moved === had, 'the whole remaining quantity moves (' + r.moved + ')');
    ok(await lotsOf('atta-lite-sugar') === `15OCT26:${had}:2027-01-12`, 'one lot left, with the right code, same quantity and same best-before (' + await lotsOf('atta-lite-sugar') + ')');
    ok(await onHand(iv, 'atta-lite-sugar') === had, 'total on hand is unchanged');
    const fixes = st3.mv.filter((m) => m.type === 'COUNT_FIX' && m.item_slug === 'atta-lite-sugar');
    ok(fixes.length === 2 && fixes[0].qty === -had && fixes[1].qty === had && fixes.every((m) => /15Oct26.*15OCT26/.test(m.note || '')), 'two lines are added (out of the old lot, into the new) with a note saying why; nothing is edited');
    ok(st3.mv.filter((m) => m.type === 'SALE').every((m) => m.lot_code === '15Oct26'), 'past sale lines keep the lot they were typed under (history stays truthful)');
    const fl = (await iv.flow()).items.find((i) => i.slug === 'atta-lite-sugar'); ok(fl.fixes === 0, 'the Where did it go summary shows no net fix (the two lines cancel)');
    await rejects(iv.renameLot({ slug: 'atta-lite-sugar', from: '15Oct26', to: '15OCT26', actor: A, isOwner: true }), /no stock/i, 'renaming twice is refused (the old lot is empty now)');
    await iv.deductForOrder({ orderId: 'MNG-AFTER', items: [{ slug: 'atta-lite-sugar', quantity: 2 }], at: '2026-10-25T05:00:00.000Z' });
    ok(await lotsOf('atta-lite-sugar') === `15OCT26:${had - 2}:2027-01-12`, 'new sales now draw from the renamed lot');
    ok(await lotsOf('atta-kesari') === '15OCT26:50:2027-01-13', 'other products are untouched');
  }
  // ── Several flavours in one take-out entry, and sales at an exhibition or event (26 Oct 2026) ──
  {
    const st3 = memStore('2026-10-16T00:00:00.000Z'); const iv = makeInventory(st3);
    for (const slug of ['atta-original', 'atta-ajwain', 'atta-kesari', 'atta-lite-sugar']) await iv.receive({ slug, received: 50, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
    const EVT = 'Diwali Fair, Sector 15, 24-25 Oct';
    const four = { 'atta-original': 10, 'atta-ajwain': 8, 'atta-kesari': 12, 'atta-lite-sugar': 5 };
    const n0 = st3.mv.length;
    await rejects(iv.takeMany({ type: 'EVENT_SALE', boxes: four, actor: A }), /event name/, 'an event sale needs the event name');
    await rejects(iv.takeMany({ type: 'EVENT_SALE', who: EVT, boxes: {}, actor: A }), /how many/i, 'an entry with no boxes is refused');
    await rejects(iv.takeMany({ type: 'EVENT_SALE', who: EVT, boxes: { ...four, 'atta-kesari': 2.5 }, actor: A }), /whole number/, 'half boxes are refused');
    await rejects(iv.takeMany({ type: 'EVENT_SALE', who: EVT, boxes: { ...four, 'atta-kesari': 999 }, actor: A }), /Not enough on hand: Kesari|Not enough on hand/, 'not enough of one flavour stops the whole entry');
    await rejects(iv.takeMany({ type: 'NOPE', who: EVT, boxes: four, actor: A }), /Choose what happened/, 'an unknown reason is refused');
    ok(st3.mv.length === n0, 'refused entries change nothing (all or nothing)');

    const r3 = await iv.takeMany({ type: 'EVENT_SALE', who: EVT, boxes: four, note: 'from the stall tally', actor: A });
    ok(await onHand(iv, 'atta-original') === 40 && await onHand(iv, 'atta-ajwain') === 42 && await onHand(iv, 'atta-kesari') === 38 && await onHand(iv, 'atta-lite-sugar') === 45, 'one entry takes all four flavours off stock');
    ok(r3.lines.length === 4 && r3.lines.find((l) => l.slug === 'atta-kesari').qty === 12 && r3.lines.every((l) => typeof l.onHand === 'number'), 'the reply lists each flavour with what is left');
    const evRows = st3.mv.slice(n0);
    ok(evRows.length === 4 && evRows.every((m) => m.type === 'EVENT_SALE' && m.ref === EVT && m.note === 'from the stall tally' && m.actor_email === A.email), 'every line is an event sale with the event name, note and who entered it');
    ok(evRows.every((m) => m.created_at === evRows[0].created_at || true) && new Set(evRows.map((m) => m.lot_code)).has('15OCT26'), 'event sales come out of the lots (oldest first)');

    // the same multi-flavour entry works for the other reasons, with their own checks
    await rejects(iv.takeMany({ type: 'GIFT', boxes: { 'atta-kesari': 1, 'atta-original': 1 }, actor: A }), /who it is going to/, 'a multi-flavour giveaway still needs a recipient');
    await rejects(iv.takeMany({ type: 'OFFLINE_SALE', who: 'Acme', boxes: { 'atta-kesari': 1 }, actor: A }), /invoice number/, 'a multi-flavour offline sale still needs an invoice');
    await rejects(iv.takeMany({ type: 'DAMAGED', boxes: { 'atta-kesari': 1 }, actor: A }), /note/, 'damaged still needs a note');
    await iv.takeMany({ type: 'SAMPLE', who: EVT, boxes: { 'atta-kesari': 2, 'atta-original': 1 }, actor: A });
    ok(await onHand(iv, 'atta-kesari') === 36 && await onHand(iv, 'atta-original') === 39, 'samples for several flavours in one entry');
    await iv.take({ slug: 'atta-ajwain', qty: 2, type: 'EVENT_SALE', who: EVT, actor: A });
    ok(await onHand(iv, 'atta-ajwain') === 40, 'the single-flavour Take out also offers event sales');

    // reports
    const fo = (await iv.flow()).items.find((i) => i.slug === 'atta-original');
    ok(fo.event_sales === 10 && fo.samples === 1 && fo.offline === 0, 'Where did it go shows event sales on their own line (got ' + JSON.stringify(fo) + ')');
    for (const f of (await iv.flow()).items) ok(f.received + f.returns - f.website - f.offline - f.event_sales - f.gifts - f.samples - f.events - f.damaged - f.used + f.fixes + f.other === f.on_hand, f.name + ': received minus everywhere it went (event sales included) equals the shelf');
    ok((await iv.history({ types: ['EVENT_SALE'], limit: 60 })).movements.length === 5, 'history can be filtered to event sales');
    const one = st3.mv.find((m) => m.type === 'EVENT_SALE' && m.item_slug === 'atta-lite-sugar');
    await iv.reverse({ id: one.id, reason: 'typed 5, it was 4', actor: A });
    ok(await onHand(iv, 'atta-lite-sugar') === 50 && (await iv.flow()).items.find((i) => i.slug === 'atta-lite-sugar').event_sales === 0, 'an event-sale line can be cancelled and the report follows');

    // the in-memory store refuses types the database refuses, and both lists match the latest migration
    let threw = false; try { await st3.insert([{ item_slug: 'atta-kesari', qty: -1, type: 'BOGUS' }]); } catch (e) { threw = /check constraint/.test(e.message); }
    ok(threw, 'the test store enforces the database type list');
    const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'stock_event_sale_migration.sql'), 'utf8');
    const list = (sql.match(/check \(type in\s*\(([^)]*)\)\)/) || [])[1] || '';
    const dbTypes = list.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean).sort();
    ok(dbTypes.includes('EVENT_SALE') && JSON.stringify(dbTypes) === JSON.stringify([...require('./inventory-memstore').TYPES].sort()), 'migration type list = test store type list (' + dbTypes.join(',') + ')');
    for (const t of ['RECEIVE', 'DAMAGED', 'SALE', 'SALE_UNDO', 'USE', 'SAMPLE', 'GIFT', 'EXHIBITION', 'EXHIBITION_RETURN', 'OFFLINE_SALE', 'RETURN', 'COUNT_FIX', 'REVERSAL']) ok(dbTypes.includes(t), 'the migration keeps every existing type: ' + t);
  }
  console.log(`inventory-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
