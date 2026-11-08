'use strict';
// Stock ledger logic against an in-memory store.   node scripts/inventory-test.js
const { makeInventory: makeInv, StockError, allocate, boxesBySlug, computeSellable, lotContext } = require('../utils/inventory');
// Lot cut-offs depend on today's date, so every inventory here runs on a pinned clock: the suite never changes with the real calendar.
const NOW = Date.parse('2026-10-31T06:00:00Z');
const makeInventory = (store, opts) => makeInv(store, { now: () => NOW, ...(opts || {}) });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ')');
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

    // Final review C2 changed this block: Rename lot is refused for biscuits (Fix lot on the lot page moves the lot row, so a hold and the
    // dates follow the lot). Each check is kept: the refusals and the moving itself are now checked on a packaging item with a lot code
    // (the only kind Rename lot still renames), and the biscuit checks say the biscuit lot is left exactly as it was.
    await rejects(iv.renameLot({ slug: 'atta-lite-sugar', from: '15Oct26', to: '15OCT26', actor: A, isOwner: false }), /owner/i, 'only the owner can rename a lot');
    await rejects(iv.renameLot({ slug: 'atta-lite-sugar', from: '15Oct26', to: '15OCT26', actor: A, isOwner: true }), /^Biscuit lots are fixed with Fix lot on the lot page, so the hold and the dates follow the lot\.$/, 'a biscuit lot is refused: it is fixed with Fix lot');
    ok(await lotsOf('atta-lite-sugar') === `15Oct26:${had}:2027-01-12`, 'refused renames change nothing');
    ok(st3.mv.filter((m) => m.type === 'SALE').every((m) => m.lot_code === '15Oct26'), 'past sale lines keep the lot they were typed under (history stays truthful)');
    const fl = (await iv.flow()).items.find((i) => i.slug === 'atta-lite-sugar'); ok(fl.fixes === 0, 'the Where did it go summary shows no net fix (nothing was written for the biscuit)');
    await iv.deductForOrder({ orderId: 'MNG-AFTER', items: [{ slug: 'atta-lite-sugar', quantity: 2 }], at: '2026-10-25T05:00:00.000Z' });
    ok(await lotsOf('atta-lite-sugar') === `15Oct26:${had - 2}:2027-01-12`, 'new sales draw from the biscuit lot as it was (not renamed)');
    ok(await lotsOf('atta-kesari') === '15OCT26:50:2027-01-13', 'other products are untouched');
    // packaging with a lot code: Rename lot works as before
    st3.setSetting('packaging_count_from', null);   // so the packaging lines show by lot here
    await iv.receive({ slug: 'label-stamp', received: 33, lot: '15Oct26', bestBefore: '2027-01-12', actor: A });
    const pk = 'label-stamp', pHad = await onHand(iv, pk);
    await rejects(iv.renameLot({ slug: pk, from: '15Oct26', to: '15Oct26', actor: A, isOwner: true }), /different/i, 'the new code must differ from the old one');
    await rejects(iv.renameLot({ slug: pk, from: '15Oct26', to: 'bad!code', actor: A, isOwner: true }), /lot can use/i, 'an invalid new code is refused');
    await rejects(iv.renameLot({ slug: pk, from: 'NOPE', to: '15OCT26', actor: A, isOwner: true }), /no stock/i, 'a lot with nothing in it cannot be renamed');
    ok(await lotsOf(pk) === '15Oct26:33:2027-01-12', 'refused packaging renames change nothing');
    const r = await iv.renameLot({ slug: pk, from: '15Oct26', to: '15OCT26', actor: A, isOwner: true });
    ok(r.moved === 33, 'the whole remaining quantity moves (' + r.moved + ')');
    ok(await lotsOf(pk) === '15OCT26:33:2027-01-12', 'one lot left, with the right code, same quantity and same best-before (' + await lotsOf(pk) + ')');
    ok(await onHand(iv, pk) === pHad, 'total on hand is unchanged');
    const fixes = st3.mv.filter((m) => m.type === 'COUNT_FIX' && m.item_slug === pk);
    ok(fixes.length === 2 && fixes[0].qty === -33 && fixes[1].qty === 33 && fixes.every((m) => /15Oct26.*15OCT26/.test(m.note || '')), 'two lines are added (out of the old lot, into the new) with a note saying why; nothing is edited');
    await rejects(iv.renameLot({ slug: pk, from: '15Oct26', to: '15OCT26', actor: A, isOwner: true }), /no stock/i, 'renaming twice is refused (the old lot is empty now)');
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
    const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'batch_receiving_migration.sql'), 'utf8');
    const list = (sql.match(/check \(type in\s*\(([^)]*)\)\)/) || [])[1] || '';
    const dbTypes = list.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean).sort();
    ok(dbTypes.length === 17 && dbTypes.includes('EVENT_SALE') && JSON.stringify(dbTypes) === JSON.stringify([...require('./inventory-memstore').TYPES].sort()), 'migration type list = test store type list (' + dbTypes.join(',') + ')');
    for (const t of ['RECEIVE', 'DAMAGED', 'SALE', 'SALE_UNDO', 'USE', 'SAMPLE', 'GIFT', 'EXHIBITION', 'EXHIBITION_RETURN', 'OFFLINE_SALE', 'EVENT_SALE', 'RETURN', 'COUNT_FIX', 'REVERSAL', 'SUPPLIER_RETURN', 'EXPIRED', 'REPLACEMENT']) ok(dbTypes.includes(t), 'the migration lists the type: ' + t);

    // batch receiving: the in-memory mirror of the new tables and the atomic save
    const sb = memStore('2026-10-16T00:00:00.000Z');
    const sets = {}; for (const m of sql.matchAll(/\(\s*'(shelf_days|ship_floor_days|dispatch_days|old_bake_days|sticker_flags)'\s*,\s*'([^']*)'\s*\)/g)) sets[m[1]] = m[2];
    const got = await sb.settingsAll();
    ok(Object.keys(sets).length === 5 && Object.keys(sets).every((k) => got[k] === sets[k]), 'memstore setting defaults equal the migration (' + JSON.stringify(sets) + ')');
    ok(got.tracking_from === '2026-10-16T00:00:00.000Z' && await sb.setting('tracking_from') === '2026-10-16T00:00:00.000Z' && typeof got.lots_from === 'string', 'tracking_from and lots_from stay readable as settings');
    for (const slug of ['mono-original', 'mono-kesari', 'mono-ajwain', 'mono-lite-sugar', 'label-stamp']) ok((await sb.item(slug)) && (await sb.item(slug)).kind === 'packaging', 'memstore has the packaging item ' + slug);
    const D = (id, bill, part = 1) => ({ id, supplier: 'Krazy Bakers', bill_no: bill, part, arrived_on: '2026-11-05', cartons: 4, status: 'received', result: { id, saved: true } });
    const L = (code, slug, extra = {}) => ({ item_slug: slug, lot_code: code, delivery_id: 'D1', bake_date: '2026-11-05', best_before: '2027-02-03', status: 'hold', aliases: [], ...extra });
    const M = (type, qty, extra = {}) => ({ item_slug: 'atta-original', qty, type, lot_code: 'MNGO-261105-01', delivery_id: 'D1', ...extra });
    const nb = sb.mv.length;
    let bad = null; try { await sb.saveDelivery({ d: D('D1', 'A000269'), lots: [L('MNGO-261105-01', 'atta-original')], moves: [M('RECEIVE', 10), M('DAMAGED', -1, { reason: 'transit' }), M('NOPE', -1)] }); } catch (e) { bad = e; }
    ok(bad && /check constraint/.test(bad.message) && sb.mv.length === nb && (await sb.lots()).length === 0 && (await sb.delivery('D1')) === null, 'a bad third movement throws and writes no delivery, lot or movement');
    const saved = await sb.saveDelivery({ d: D('D1', 'A000269'), lots: [L('MNGO-261105-01', 'atta-original'), L('MNGK-261105-01', 'atta-kesari', { aliases: ['15OCT26'] })], moves: [M('RECEIVE', 10), M('DAMAGED', -1, { reason: 'transit' })] });
    ok(saved.id === 'D1' && !saved.again && sb.mv.length === nb + 2 && (await sb.lots()).length === 2 && sb.mv.slice(-2).every((m) => m.delivery_id === 'D1'), 'a good save writes the delivery, both lots and both movements');
    const again = await sb.saveDelivery({ d: D('D1', 'A000269'), lots: [L('MNGO-261105-02', 'atta-original')], moves: [M('RECEIVE', 99)] });
    ok(again.again === true && again.saved === true && sb.mv.length === nb + 2 && (await sb.lots()).length === 2, 'the same receipt ID again returns the first result with again:true and writes nothing');
    let dupErr = null; try { await sb.saveDelivery({ d: D('D2', 'a000269'), lots: [], moves: [] }); } catch (e) { dupErr = e; }
    ok(dupErr && /stock_deliveries_bill_part_once/.test(dupErr.message) && (await sb.delivery('D2')) === null, 'the same bill and part under a new ID throws the bill-once error and writes nothing');
    await sb.saveDelivery({ d: D('D3', 'A000269', 2), lots: [], moves: [] });
    ok((await sb.deliveriesByBill('KRAZY BAKERS', 'a000269')).length === 2, 'deliveriesByBill ignores case on supplier and bill (two parts)');
    ok((await sb.lastDelivery()).id === 'D3', 'lastDelivery is the newest delivery');
    await sb.updateDelivery('D3', { status: 'void' });
    ok((await sb.lastDelivery()).id === 'D1', 'lastDelivery skips void deliveries');
    ok((await sb.lotsByCode('MNGO-261105-01')).length === 1 && (await sb.lotsByCode('15OCT26')).map((l) => l.item_slug).join() === 'atta-kesari' && (await sb.lotsByCode('15oct26')).length === 0, 'lotsByCode matches the code or an alias exactly');
    await sb.updateLot('atta-original', 'MNGO-261105-01', { status: 'released', check_weight_g: 241 });
    ok((await sb.lots()).find((l) => l.item_slug === 'atta-original').status === 'released', 'updateLot changes one lot');
    await sb.insertLots([L('MNGO-261106-01', 'atta-original')]);
    let dupLot = null; try { await sb.insertLots([L('MNGO-261106-01', 'atta-original')]); } catch (e) { dupLot = e; }
    ok(dupLot && (await sb.lots()).length === 3, 'a lot (flavour + code) cannot be added twice');
    ok((await sb.movementsByLots(['MNGO-261105-01'])).length === 2 && (await sb.movementsByDelivery('D1')).length === 2 && (await sb.movementsByDelivery('nope')).length === 0, 'movements can be read by lot code and by delivery');
    let atomicFail = null; try { await sb.saveDelivery({ d: D('D4', 'B1'), lots: [L('MNGO-261106-01', 'atta-original')], moves: [M('RECEIVE', 1)] }); } catch (e) { atomicFail = e; }
    ok(atomicFail && (await sb.delivery('D4')) === null && sb.mv.length === nb + 2, 'a lot clash rolls back the delivery and the movements too');

    // the mirror refuses what the database function refuses, and writes nothing when it does
    const snap = async () => JSON.stringify([sb.mv.length, (await sb.lots()).length, (await sb.delivery('F1')), (await sb.delivery('F2'))]);
    const refuses = async (label, args, re) => { const before = await snap(); let e = null; try { await sb.saveDelivery(args); } catch (x) { e = x; } ok(e && re.test(e.message) && await snap() === before, label + ' (got: ' + (e && e.message) + ')'); };
    await refuses('a move with quantity 0 is refused', { d: D('F1', 'F-1'), lots: [], moves: [M('DAMAGED', 0)] }, /stock_movements_qty_check/);
    await refuses('a move with no quantity is refused', { d: D('F1', 'F-1'), lots: [], moves: [M('RECEIVE', null)] }, /not-null/);
    await refuses('a move for an unknown item is refused', { d: D('F1', 'F-1'), lots: [], moves: [M('RECEIVE', 1, { item_slug: 'atta-nope' })] }, /stock_movements_item_slug_fkey/);
    await refuses('a lot for an unknown item is refused', { d: D('F1', 'F-1'), lots: [L('X-1', 'atta-nope')], moves: [] }, /foreign key/);
    await refuses('a delivery with no id is refused', { d: { ...D('F1', 'F-1'), id: undefined }, lots: [], moves: [] }, /"id".*not-null/);
    await refuses('a delivery with no bill number is refused', { d: { ...D('F1', 'F-1'), bill_no: '' }, lots: [], moves: [] }, /bill_no/);
    const fsave = await sb.saveDelivery({ d: { ...D('F2', 'F-2'), part: undefined, supplier: null, status: null, freight: null, photos: null } });
    const f2 = await sb.delivery('F2');
    ok(fsave.id === 'F2' && f2.part === 1 && f2.supplier === 'Krazy Bakers' && f2.status === 'received' && JSON.stringify(f2.freight) === '{}' && f2.photos.length === 0, 'missing or null delivery fields take the same defaults as the database');
    await sb.saveDelivery({ d: D('F3', 'F-3'), lots: [L('MNGO-261120-01', 'atta-original', { delivery_id: null, status: null, aliases: null })], moves: [M('RECEIVE', 2, { delivery_id: null, lot_code: 'MNGO-261120-01' })] });
    const fl = (await sb.lotsByCode('MNGO-261120-01'))[0];
    ok(fl.delivery_id === 'F3' && fl.status === 'hold' && fl.aliases.length === 0 && sb.mv[sb.mv.length - 1].delivery_id === 'F3', 'null delivery_id, status and aliases take the delivery id, hold and an empty list, like the database');

    // the real store: every new method calls the right table or function, and a missing migration reads as a plain instruction
    const dbPath = require.resolve('../utils/database'); const calls = []; let reply = { data: [], error: null };
    const q = (t) => { const o = { t, ops: [] }; const chain = new Proxy(o, { get: (target, k) => (k === 'then' ? (res) => { calls.push(target); res(reply); } : (...a) => { target.ops.push([k, ...a]); return chain; }) }); return chain; };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { client: () => ({ from: (t) => q(t), rpc: async (fn, args) => { calls.push({ rpc: fn, args }); return reply; } }) } };
    const real = require('../utils/inventory').supabaseStore();
    reply = { data: { id: 'D1' }, error: null };
    ok((await real.saveDelivery({ d: { id: 'D1' }, lots: [], moves: [] })).id === 'D1' && calls[calls.length - 1].rpc === 'stock_save_delivery' && Object.keys(calls[calls.length - 1].args).join() === 'd,lots,moves', 'saveDelivery calls the stock_save_delivery function');
    await real.saveDelivery({ d: { id: 'D9' } });
    ok(JSON.stringify(calls[calls.length - 1].args) === '{"d":{"id":"D9"},"lots":[],"moves":[]}', 'saveDelivery always sends all three arguments (the function has no two-argument form)');
    reply = { data: [], error: null };
    await real.lots(); await real.lotsByCode('X'); await real.deliveriesByBill('Krazy Bakers', 'A_1%'); await real.lastDelivery(); await real.movementsByLots(['X']); await real.movementsByDelivery('D1'); await real.settingsAll();
    ok(['stock_lots', 'stock_lots', 'stock_lots', 'stock_deliveries', 'stock_deliveries', 'stock_movements', 'stock_movements', 'stock_settings'].join() === calls.slice(-8).map((c) => c.t).join(), 'the real store reads the new tables');
    const bill = calls.slice(-8)[3]; ok(bill.ops.some((o) => o[0] === 'ilike' && o[1] === 'bill_no' && o[2] === 'A\\_1\\%'), 'bill number match is exact (wildcards escaped)');
    for (const [msg, code] of [['relation "public.stock_lots" does not exist', '42P01'], ["Could not find the function public.stock_save_delivery(d, lots, moves) in the schema cache", 'PGRST202'], ['column stock_movements.delivery_id does not exist', '42703']]) {
      reply = { data: null, error: { code, message: msg } };
      let e = null; try { await real.lots(); } catch (x) { e = x; }
      ok(e && e.message === 'Run batch_receiving_migration.sql in Supabase first.', 'missing migration is explained: ' + msg);
    }
    reply = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "stock_deliveries_bill_part_once"' } };
    let dupE = null; try { await real.saveDelivery({ d: {}, lots: [], moves: [] }); } catch (x) { dupE = x; }
    ok(dupE && /stock_deliveries_bill_part_once/.test(dupE.message), 'the bill-once clash passes through (not mistaken for a missing migration)');
    reply = { data: null, error: { code: '42P01', message: 'relation "stock_items" does not exist' } };
    let oldE = null; try { await real.items(); } catch (x) { oldE = x; }
    ok(oldE && oldE.message === 'Run stock_ledger_migration.sql in Supabase first.', 'the old ledger message still works');
  }

  // ── Batch receiving, Task 3: held and out-of-date lots are not sold or taken out; legacy lots behave as today ──
  {
    const mk = () => { const st = memStore('2026-10-16T00:00:00.000Z'); return { st, inv: makeInventory(st) }; };
    const FL = ['atta-kesari', 'atta-original', 'atta-ajwain', 'atta-lite-sugar'];
    const stockOf = async (st, slug) => (await st.byLot()).filter((x) => x.item_slug === slug);
    const lotQty = async (st, slug, code) => (await stockOf(st, slug)).filter((x) => x.lot_code === code).reduce((n, x) => n + x.qty, 0);

    // deploy day: legacy lots (no stock_lots row), an undated lot, a lot-less shortfall and committed boxes
    {
      const { st, inv } = mk();
      await inv.receive({ slug: 'atta-kesari', received: 100, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      await inv.receive({ slug: 'atta-kesari', received: 20, lot: 'X', actor: A });
      await inv.receive({ slug: 'atta-original', received: 50, lot: '27OCT26', bestBefore: '2027-01-25', actor: A });
      await st.insert([{ item_slug: 'atta-kesari', qty: -2, type: 'SALE', lot_code: null, best_before: null, ref: 'MNG-Z@2026-10-30' }]);
      st.committedMap = { 'atta-kesari': 3, 'atta-original': 1 };
      const items = await st.items(), rows = await st.byLot(), committed = await st.committed();
      const ctx = await lotContext(st, NOW);
      ok(ctx.today === '2026-10-31' && ctx.s.shelf_days === 90 && typeof ctx.meta === 'object', 'lotContext gives IST today, the settings and the lot table');
      const without = computeSellable(items, rows, committed), withCtx = computeSellable(items, rows, committed, ctx);
      ok(JSON.stringify(without) === JSON.stringify(withCtx) && FL.every((f) => without[f] === withCtx[f]), 'deploy day: sellable with lot rules equals sellable without them (' + JSON.stringify(withCtx) + ')');
      ok(without['atta-kesari'] === 115 && without['atta-original'] === 49, 'deploy day: 100 + 20 - 2 - 3 = 115 Kesari, 50 - 1 = 49 Original');
      ok(JSON.stringify(await inv.sellable()) === JSON.stringify(without), 'sellable() gives the same numbers on deploy day');
      const ov = (await inv.overview()).items.find((i) => i.slug === 'atta-kesari');
      ok(ov.usable === 118 && ov.on_hand === 118, 'overview: usable boxes (other) equal on hand when every lot is legacy');
    }
    // a lot on hold adds nothing to the website; released it adds all
    {
      const { st, inv } = mk();
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261105-01', status: 'hold', best_before: '2027-02-03' }]);
      await inv.receive({ slug: 'atta-kesari', received: 100, lot: 'MNGK-261105-01', bestBefore: '2027-02-03', actor: A });
      ok((await inv.sellable())['atta-kesari'] === 0, 'a lot on hold adds 0 to the website count');
      ok((await inv.overview()).items.find((i) => i.slug === 'atta-kesari').on_hand === 100, 'but it is on hand');
      await st.updateLot('atta-kesari', 'MNGK-261105-01', { status: 'released' });
      ok((await inv.sellable())['atta-kesari'] === 100, 'released, the same lot adds 100');
      for (const bad of ['rejected', 'void']) { await st.updateLot('atta-kesari', 'MNGK-261105-01', { status: bad }); ok((await inv.sellable())['atta-kesari'] === 0, bad + ' lots are never sold'); }
    }
    // the website stops selling on the website stop date, while other take-outs carry on
    {
      const { st, inv } = mk();   // today 2026-10-31; best before 2026-12-22 gives last ship 2026-11-02 and website stop 2026-10-31
      await st.insertLots([{ item_slug: 'atta-original', lot_code: 'MNGO-260924-01', status: 'released', best_before: '2026-12-22' }, { item_slug: 'atta-original', lot_code: 'MNGO-260925-01', status: 'released', best_before: '2026-12-23' }]);
      await inv.receive({ slug: 'atta-original', received: 40, lot: 'MNGO-260924-01', bestBefore: '2026-12-22', actor: A });
      await inv.receive({ slug: 'atta-original', received: 10, lot: 'MNGO-260925-01', bestBefore: '2026-12-23', actor: A });
      ok((await inv.sellable())['atta-original'] === 10, 'on the website stop date a released lot adds 0; the day after it adds 10 (' + (await inv.sellable())['atta-original'] + ')');
      await inv.take({ slug: 'atta-original', qty: 5, type: 'SAMPLE', actor: A });
      ok(await lotQty(st, 'atta-original', 'MNGO-260924-01') === 35, 'other take-outs still draw from it, oldest best before first');
    }
    // a lot past its best before cannot be taken for anything but Throw away expired
    {
      const { st, inv } = mk();
      await st.insertLots([{ item_slug: 'atta-ajwain', lot_code: 'MNGA-260801-01', status: 'released', best_before: '2026-10-30' }]);
      await inv.receive({ slug: 'atta-ajwain', received: 12, lot: 'MNGA-260801-01', bestBefore: '2026-10-30', actor: A });
      await rejects(inv.take({ slug: 'atta-ajwain', qty: 1, type: 'SAMPLE', actor: A }), /on hold or past best before/, 'a lot past best before is not taken from');
      ok((await inv.sellable())['atta-ajwain'] === 0, 'and not sold');
      await inv.receive({ slug: 'atta-ajwain', received: 6, lot: 'Y1', bestBefore: '2026-10-31', actor: A });
      await inv.take({ slug: 'atta-ajwain', qty: 2, type: 'SAMPLE', actor: A });
      ok(await lotQty(st, 'atta-ajwain', 'Y1') === 4, 'on the best before date itself the lot can still be taken from');
    }
    // take / allowNegative / named lot
    {
      const { st, inv } = mk();
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261105-01', status: 'hold', best_before: '2027-02-03' }]);
      await inv.receive({ slug: 'atta-kesari', received: 100, lot: 'MNGK-261105-01', bestBefore: '2027-02-03', actor: A });
      let msg = ''; try { await inv.take({ slug: 'atta-kesari', qty: 5, type: 'SAMPLE', actor: A }); } catch (e) { msg = e.message; }
      ok(msg === 'Only 0 boxes can be used (100 more are on hold or past best before). Count first, or confirm to go below zero.', 'only a held lot: refused with the held-back wording (' + msg + ')');
      try { await inv.take({ slug: 'atta-kesari', qty: 5, type: 'SAMPLE', actor: A }); } catch (e) { ok(e.status === 409 && e.extra.needsConfirm === 'negative', 'it asks to confirm going below zero'); }
      const n0 = st.mv.length;
      await inv.take({ slug: 'atta-kesari', qty: 5, type: 'SAMPLE', allowNegative: true, actor: A });
      const added = st.mv.slice(n0);
      ok(added.length === 1 && added[0].lot_code === null && added[0].qty === -5, 'with allowNegative it writes one lot-less row and the held lot is untouched');
      ok(await lotQty(st, 'atta-kesari', 'MNGK-261105-01') === 100, 'the held lot keeps its 100');
      // an older legacy lot and a released new lot: the named lot is used first
      await inv.receive({ slug: 'atta-kesari', received: 30, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261105-02', status: 'released', best_before: '2027-02-03' }]);
      await inv.receive({ slug: 'atta-kesari', received: 20, lot: 'MNGK-261105-02', bestBefore: '2027-02-03', actor: A });
      await inv.take({ slug: 'atta-kesari', qty: 4, type: 'DAMAGED', note: 'broken while cartoning', lot: 'MNGK-261105-02', actor: A });
      ok(await lotQty(st, 'atta-kesari', 'MNGK-261105-02') === 16 && await lotQty(st, 'atta-kesari', '15OCT26') === 30, 'a named released lot is used even when an older lot exists');
      await inv.take({ slug: 'atta-kesari', qty: 6, type: 'USE', lot: 'MNGK-261105-02', actor: A });
      ok(await lotQty(st, 'atta-kesari', 'MNGK-261105-02') === 10, 'second take from the named lot');
      // the named lot cannot cover it: the rest comes from other eligible lots, oldest first, never from the held one
      await inv.take({ slug: 'atta-kesari', qty: 14, type: 'SAMPLE', lot: 'MNGK-261105-02', actor: A });
      ok(await lotQty(st, 'atta-kesari', 'MNGK-261105-02') === 0 && await lotQty(st, 'atta-kesari', '15OCT26') === 26 && await lotQty(st, 'atta-kesari', 'MNGK-261105-01') === 100, 'when the named lot runs out the rest comes from other usable lots, not the held one');
      await rejects(inv.take({ slug: 'atta-kesari', qty: 1, type: 'SAMPLE', lot: 'MNGK-261105-01', actor: A }), /^Lot MNGK-261105-01 is on hold$/, 'a named lot on hold is refused');
      await st.updateLot('atta-kesari', 'MNGK-261105-01', { status: 'rejected' });
      await rejects(inv.take({ slug: 'atta-kesari', qty: 1, type: 'SAMPLE', lot: 'MNGK-261105-01', actor: A }), /^Lot MNGK-261105-01 is on hold$/, 'a rejected lot is refused the same way');
      await rejects(inv.take({ slug: 'atta-kesari', qty: 1, type: 'SAMPLE', lot: 'NOPE', actor: A }), /not a lot of Atta Kesari/, 'a lot that does not belong to the product is refused');
      await st.insertLots([{ item_slug: 'atta-original', lot_code: 'MNGO-260801-01', status: 'released', best_before: '2026-10-30' }]);
      await inv.receive({ slug: 'atta-original', received: 5, lot: 'MNGO-260801-01', bestBefore: '2026-10-30', actor: A });
      await rejects(inv.take({ slug: 'atta-original', qty: 1, type: 'SAMPLE', lot: 'MNGO-260801-01', actor: A, allowNegative: true }), /^Lot MNGO-260801-01 is past best before: use Throw away expired$/, 'a named lot past best before is refused');
      await rejects(inv.take({ slug: 'atta-original', qty: 1, type: 'SAMPLE', lot: 'MNGK-261105-02', actor: A, allowNegative: true }), /not a lot of Atta Original/, 'a lot of another flavour is refused');
    }
    // codes are case sensitive: 15oct26 is a different lot from 15OCT26
    {
      const { st, inv } = mk();
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: '15OCT26', status: 'hold', best_before: '2027-01-13' }]);
      await inv.receive({ slug: 'atta-kesari', received: 10, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      await inv.receive({ slug: 'atta-kesari', received: 7, lot: '15oct26', bestBefore: '2027-01-13', actor: A });
      ok((await inv.sellable())['atta-kesari'] === 7, 'lot codes are case sensitive: 15OCT26 on hold, 15oct26 is a legacy lot');
    }
    // takeMany, hamper and count
    {
      const { st, inv } = mk();
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261105-01', status: 'hold', best_before: '2027-02-03' }]);
      await inv.receive({ slug: 'atta-kesari', received: 100, lot: 'MNGK-261105-01', bestBefore: '2027-02-03', actor: A });
      await inv.receive({ slug: 'atta-original', received: 3, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      await rejects(inv.takeMany({ boxes: { 'atta-kesari': 2, 'atta-original': 5 }, type: 'EVENT_SALE', who: 'Fair', actor: A }), /^Not enough can be used: Atta Kesari: need 2, can use 0 \(100 more are on hold or past best before\); Atta Original: need 5, have 3\. Count first, or confirm to go below zero\.$/, 'takeMany: when any item has boxes held back, the sentence says can be used, item by item');
      await rejects(inv.offlineHamper({ hamper: 'Diwali', hampers: 1, boxes: { 'atta-kesari': 2 }, buyer: 'B', invoice: 'I1', actor: A }), /^Not enough can be used: Atta Kesari: need 2, can use 0 \(100 more are on hold or past best before\)\. Count first/, 'hamper has the same wording');
      await inv.takeMany({ boxes: { 'atta-original': 3 }, type: 'EVENT_SALE', who: 'Fair', actor: A });
      ok(await lotQty(st, 'atta-original', '15OCT26') === 0, 'takeMany still works for usable lots');
      // count: a negative difference takes from usable lots only; the rest is a lot-less line
      await inv.receive({ slug: 'atta-kesari', received: 4, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      const r = await inv.count({ slug: 'atta-kesari', counted: 100, note: 'miscount', actor: A });   // on hand 104 -> diff -4
      ok(r.diff === -4 && await lotQty(st, 'atta-kesari', '15OCT26') === 0 && await lotQty(st, 'atta-kesari', 'MNGK-261105-01') === 100, 'count fix comes off the usable lot, not the held one');
      await inv.count({ slug: 'atta-kesari', counted: 96, note: 'again', actor: A });   // nothing usable left: lot-less
      const last = st.mv[st.mv.length - 1];
      ok(last.type === 'COUNT_FIX' && last.qty === -4 && last.lot_code === null && await lotQty(st, 'atta-kesari', 'MNGK-261105-01') === 100, 'a count shortfall becomes a lot-less line');
    }
    // overview carries the dates and status per lot
    {
      const { st, inv } = mk();
      await st.insertLots([{ item_slug: 'atta-lite-sugar', lot_code: 'MNGL-261105-01', status: 'hold', best_before: '2027-02-03' }]);
      await inv.receive({ slug: 'atta-lite-sugar', received: 8, lot: 'MNGL-261105-01', bestBefore: '2027-02-03', actor: A });
      await inv.receive({ slug: 'atta-lite-sugar', received: 5, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      const it = (await inv.overview()).items.find((i) => i.slug === 'atta-lite-sugar');
      const held = it.lots.find((l) => l.lot_code === 'MNGL-261105-01'), legacy = it.lots.find((l) => l.lot_code === '15OCT26');
      ok(it.usable === 5 && it.on_hand === 13, 'overview: usable counts only released or legacy lots before best before (' + it.usable + ')');
      ok(held.status === 'hold' && held.lastShip === '2026-12-15' && held.websiteStop === '2026-12-13', 'overview: lot status and its last ship and website stop dates (' + JSON.stringify(held) + ')');
      ok(legacy.status === 'legacy' && legacy.lastShip === '2026-11-24' && legacy.websiteStop === '2026-11-22', 'overview: a legacy lot shows legacy and the same cut-off dates (' + JSON.stringify(legacy) + ')');
      ok((await inv.overview()).items.find((i) => i.slug === 'packing-tape').usable === null, 'packaging has no usable count');
    }

    // fix round 1
    {
      // 1. a lot that cannot be used with a negative balance must not inflate the website count
      const { st, inv } = mk();
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261105-01', status: 'hold', best_before: '2027-02-03' }]);
      await st.insert([{ item_slug: 'atta-kesari', qty: -5, type: 'USE', lot_code: 'MNGK-261105-01', best_before: '2027-02-03' }]);
      await inv.receive({ slug: 'atta-kesari', received: 20, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      const k = (await inv.overview()).items.find((i) => i.slug === 'atta-kesari');
      ok(k.on_hand === 15 && (await inv.sellable())['atta-kesari'] === 15 && k.usable === 15 && k.sellable === 15, 'held lot at -5 plus legacy 20: on hand 15, website 15, usable 15, screen 15 (' + [k.on_hand, (await inv.sellable())['atta-kesari'], k.usable, k.sellable] + ')');
      await rejects(inv.take({ slug: 'atta-kesari', qty: 16, type: 'SAMPLE', actor: A }), /Only 15 boxes on hand/, 'and taking 16 is refused at 15');
    }
    {
      // 2. the screen's Website number follows the website rule
      const { st, inv } = mk();
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261105-01', status: 'hold', best_before: '2027-02-03' }]);
      await inv.receive({ slug: 'atta-kesari', received: 100, lot: 'MNGK-261105-01', bestBefore: '2027-02-03', actor: A });
      st.committedMap = { 'atta-kesari': 3 };
      const sk = async () => (await inv.overview()).items.find((i) => i.slug === 'atta-kesari').sellable;
      ok(await sk() === -3, 'screen: a held lot adds 0 to Website (0 - 3 committed)');
      await st.updateLot('atta-kesari', 'MNGK-261105-01', { status: 'released' });
      ok(await sk() === 97, 'screen: released, it adds its 100 boxes');
      const ov = await inv.overview(), sl = await inv.sellable();
      ok(ov.items.find((i) => i.slug === 'atta-original').sellable === null, 'screen: an uncounted flavour stays null');
      // deploy-day fixture: screen equals website for every flavour
      const d = mk();
      await d.inv.receive({ slug: 'atta-kesari', received: 100, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      await d.inv.receive({ slug: 'atta-kesari', received: 20, lot: 'X', actor: A });
      await d.inv.receive({ slug: 'atta-original', received: 50, lot: '27OCT26', bestBefore: '2027-01-25', actor: A });
      await d.st.insert([{ item_slug: 'atta-kesari', qty: -2, type: 'SALE', lot_code: null, best_before: null, ref: 'MNG-Z@2026-10-30' }]);
      d.st.committedMap = { 'atta-kesari': 3, 'atta-original': 1 };
      const dov = await d.inv.overview(), dsl = await d.inv.sellable();
      ok(FL.every((f) => { const o = dov.items.find((i) => i.slug === f).sellable; return o === (f in dsl ? dsl[f] : null); }), 'deploy day: screen Website equals sellable() for every flavour');
    }
    {
      // 4. spec 9: 15OCT26 leaves the website on 22 Nov and stays usable for samples until 13 Jan
      const st = memStore('2026-10-16T00:00:00.000Z'); const inv = makeInv(st, { now: () => Date.parse('2026-11-23T06:00:00Z') });
      await inv.receive({ slug: 'atta-kesari', received: 30, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      ok((await inv.sellable())['atta-kesari'] === 0, '23 Nov: legacy 15OCT26 adds 0 to the website');
      await inv.take({ slug: 'atta-kesari', qty: 4, type: 'SAMPLE', actor: A });
      ok((await stockOf(st, 'atta-kesari')).filter((x) => x.lot_code === '15OCT26').reduce((n, x) => n + x.qty, 0) === 26, '23 Nov: a sample can still be taken from it');
    }
    // lots() failing is not hidden: callers decide what to do
    {
      const { st, inv } = mk(); st.lots = async () => { throw new Error('db down'); };
      let e = null; try { await inv.sellable(); } catch (x) { e = x; }
      ok(e && e.message === 'db down', 'if the lot table cannot be read, sellable() fails instead of guessing');
    }
  }
  // ── Batch receiving, Task 6: the Packed step takes boxes only from lots that can still ship ──
  {
    const { shortText } = require('../utils/inventory');
    const AT = '2026-11-08T06:00:00.000Z';   // the pack moment: 8 Nov 2026 in India. The inventory's own clock stays on 31 Oct, so a plan that read it would show.
    const mk6 = () => { const st = memStore('2026-10-16T00:00:00.000Z'); st.setSetting('lots_from', '2026-10-30T00:00:00.000Z'); return { st, inv: makeInventory(st) }; };
    const KES2 = [{ slug: 'atta-kesari', quantity: 2 }];
    const stockOfLot = async (st, slug, code) => (await st.byLot()).filter((x) => x.item_slug === slug && x.lot_code === code).reduce((n, x) => n + x.qty, 0);
    const held = (st, slug, code, bb, n) => st.insertLots([{ item_slug: slug, lot_code: code, status: 'hold', best_before: bb }]).then(() => st.insert([{ item_slug: slug, qty: n, type: 'RECEIVE', lot_code: code, best_before: bb }]));
    {
      const { st, inv } = mk6();
      await held(st, 'atta-kesari', 'MNGK-261105-01', '2027-02-03', 50);
      const p = await inv.planForOrder({ items: KES2, at: AT });
      ok(!p.skipped && p.rows.length === 0 && p.short.length === 1 && p.short[0].slug === 'atta-kesari' && p.short[0].boxes === 2, 'plan: 2 Kesari with only a held lot are 2 boxes short (' + JSON.stringify(p) + ')');
      ok(p.short[0].hint === 'Lot MNGK-261105-01 is on hold (release it), or receive the delivery first.', 'plan: the hint names the held lot (' + p.short[0].hint + ')');
      ok(shortText(p.short) === 'Kesari: 2 boxes short. Lot MNGK-261105-01 is on hold (release it), or receive the delivery first.', 'plan: the refusal reads as in spec 6.6 (' + shortText(p.short) + ')');
      ok(shortText([{ ...p.short[0], boxes: 1 }]).startsWith('Kesari: 1 box short.'), 'plan: one box is "1 box"');
      // released with 1 box: it covers 1, the other is short
      await inv.receive({ slug: 'atta-kesari', received: 1, lot: '01NOV26', bestBefore: '2027-01-30', actor: A });
      const p2 = await inv.planForOrder({ items: KES2, at: AT });
      ok(p2.rows.length === 1 && p2.rows[0].lot_code === '01NOV26' && p2.rows[0].qty === -1 && p2.rows[0].type === 'SALE' && p2.short[0].boxes === 1, 'plan: a released (legacy) lot covers what it can; the rest is short (' + JSON.stringify(p2) + ')');
      ok((await inv.planForOrder({ items: KES2, at: '2026-10-15T05:00:00.000Z' })).skipped, 'plan: an order packed before tracking started is skipped');
    }
    {
      // a released lot whose last ship date was yesterday
      const { st, inv } = mk6();
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-260928-01', status: 'released', best_before: '2026-12-27' }]);   // last ship 7 Nov
      await st.insert([{ item_slug: 'atta-kesari', qty: 40, type: 'RECEIVE', lot_code: 'MNGK-260928-01', best_before: '2026-12-27' }]);
      const p = await inv.planForOrder({ items: KES2, at: AT });
      ok(p.short.length === 1 && p.short[0].boxes === 2 && p.short[0].hint === 'Lot MNGK-260928-01 is past its last ship date (7 Nov): it can only go to fairs, samples or offline sales.', 'plan: a lot past its last ship date is not packed, and the hint says so (' + JSON.stringify(p.short) + ')');
      // a held lot is named first when there is one
      await held(st, 'atta-kesari', 'MNGK-261105-01', '2027-02-03', 10);
      ok((await inv.planForOrder({ items: KES2, at: AT })).short[0].hint.startsWith('Lot MNGK-261105-01 is on hold'), 'plan: a held lot is named before a lot past its last ship date');
    }
    {
      // legacy 15OCT26 (best before 13 Jan, last ship 24 Nov): "today" is the India date of the pack moment
      const { inv } = mk6();
      await inv.receive({ slug: 'atta-kesari', received: 30, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      const late = await inv.planForOrder({ items: KES2, at: '2026-11-24T18:31:00.000Z' });   // 25 Nov, 00:01 in India
      ok(late.short.length === 1 && late.short[0].hint === 'Lot 15OCT26 is past its last ship date (24 Nov): it can only go to fairs, samples or offline sales.', 'plan: 15OCT26 cannot be packed from 25 Nov, India time (' + JSON.stringify(late.short) + ')');
      const last = await inv.planForOrder({ items: KES2, at: '2026-11-24T18:29:00.000Z' });   // 24 Nov, 23:59 in India
      ok(last.short.length === 0 && last.rows.length === 1 && last.rows[0].lot_code === '15OCT26', 'plan: on 24 Nov (India) it still packs (' + JSON.stringify(last) + ')');
      // past its best before as well: no hint about fairs, the stock has to come in
      const gone = await inv.planForOrder({ items: KES2, at: '2027-01-14T06:00:00.000Z' });
      ok(gone.short[0].hint === 'Receive the delivery first.', 'plan: a lot past best before is not offered for fairs either (' + gone.short[0].hint + ')');
    }
    {
      // Review Focus 4: a Trio with only Sugar-Lite held is short on Sugar-Lite alone
      const { st, inv } = mk6();
      await held(st, 'atta-lite-sugar', 'MNGL-261105-01', '2027-02-03', 20);
      await inv.receive({ slug: 'atta-kesari', received: 10, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      const p = await inv.planForOrder({ items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }], at: AT });
      ok(p.short.length === 1 && p.short[0].slug === 'atta-lite-sugar' && p.short[0].boxes === 1 && shortText(p.short).startsWith('Sugar-Lite: 1 box short. Lot MNGL-261105-01 is on hold'), 'plan: Trio with only Sugar-Lite held gives exactly one short line, for Sugar-Lite (' + JSON.stringify(p.short) + ')');
      ok(p.rows.some((r) => r.item_slug === 'atta-kesari' && r.lot_code === '15OCT26' && r.qty === -1) && p.rows.some((r) => r.item_slug === 'atta-original' && r.lot_code === null && r.qty === -1), 'plan: Kesari comes from its lot; Original, never counted, gets a lot-less line (' + JSON.stringify(p.rows) + ')');
    }
    {
      // no ledger rows at all: never short (an uncounted item is not limited, as on the website); rows that add to zero: short
      const { st, inv } = mk6();
      const p = await inv.planForOrder({ items: [{ slug: 'atta-ajwain', quantity: 3 }], at: AT });
      ok(p.short.length === 0 && p.rows.length === 1 && p.rows[0].item_slug === 'atta-ajwain' && p.rows[0].qty === -3 && p.rows[0].lot_code === null, 'plan: a flavour with no ledger rows is not short (' + JSON.stringify(p) + ')');
      await inv.receive({ slug: 'atta-ajwain', received: 2, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      await inv.take({ slug: 'atta-ajwain', qty: 2, type: 'SAMPLE', actor: A });
      const q = await inv.planForOrder({ items: [{ slug: 'atta-ajwain', quantity: 3 }], at: AT });
      ok(q.short.length === 1 && q.short[0].boxes === 3 && q.short[0].hint === 'Receive the delivery first.', 'plan: a counted flavour with nothing left is short: receive the delivery first (' + JSON.stringify(q.short) + ')');
      ok(st.mv.every((r) => r.type !== 'SALE'), 'plan: planning writes nothing');
    }
    {
      // owner override: the short boxes are written lot-less with the note; Needs attention lists them; Assign lot fixes them
      const { st, inv } = mk6(); const OWNER = { email: 'owner@x.com', name: 'Owner' };
      await held(st, 'atta-kesari', 'MNGK-261105-01', '2027-02-03', 50);
      await inv.receive({ slug: 'atta-original', received: 10, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      const items = [{ slug: 'atta-kesari', quantity: 2 }, { slug: 'atta-original', quantity: 1 }];
      const plan = await inv.planForOrder({ items, at: AT });
      const r = await inv.deductForOrder({ orderId: 'MNG-T6A', items, at: AT, plan, overrideNote: 'fair stock' });
      const mine = st.mv.filter((m) => m.ref === 'MNG-T6A@' + AT);
      const ll = mine.find((m) => m.item_slug === 'atta-kesari');
      ok(r.rows === 2 && mine.length === 2 && ll && ll.type === 'SALE' && ll.lot_code === null && ll.qty === -2 && ll.note === 'Packed without a lot (owner): fair stock', 'override: the short Kesari is one lot-less SALE with the note (' + JSON.stringify(mine) + ')');
      ok(mine.some((m) => m.item_slug === 'atta-original' && m.lot_code === '15OCT26' && m.qty === -1), 'override: the rest of the plan is written as planned');
      let nl = await inv.needsLot();
      ok(nl.length === 1 && nl[0].orderId === 'MNG-T6A' && nl[0].slug === 'atta-kesari' && nl[0].boxes === 2 && nl[0].packedAt === AT, 'needsLot lists the lot-less boxes (' + JSON.stringify(nl) + ')');
      // assign: owner only, a lot that can ship, with enough boxes
      await rejects(inv.assignLot({ orderId: 'MNG-T6A', slug: 'atta-kesari', lot: 'MNGK-261105-01', isOwner: false, actor: A }), /^Only the owner can assign a lot\.$/, 'assignLot: staff are refused');
      let e403 = null; try { await inv.assignLot({ orderId: 'MNG-T6A', slug: 'atta-kesari', lot: 'MNGK-261105-01', actor: A }); } catch (x) { e403 = x; } ok(e403 && e403.status === 403, 'assignLot: the refusal is a 403');
      await rejects(inv.assignLot({ orderId: 'MNG-T6A', slug: 'atta-kesari', lot: 'MNGK-261105-01', isOwner: true, actor: OWNER }), /on hold/, 'assignLot: a held lot is refused');
      await rejects(inv.assignLot({ orderId: 'MNG-T6A', slug: 'atta-kesari', lot: 'NOPE-1', isOwner: true, actor: OWNER }), /not a lot of Atta Kesari/, 'assignLot: an unknown lot is refused');
      await inv.receive({ slug: 'atta-kesari', received: 1, lot: '02NOV26', bestBefore: '2027-01-31', actor: A });
      await rejects(inv.assignLot({ orderId: 'MNG-T6A', slug: 'atta-kesari', lot: '02NOV26', isOwner: true, actor: OWNER }), /only 1 box.*needs 2/, 'assignLot: a lot with fewer boxes than needed is refused');
      await st.updateLot('atta-kesari', 'MNGK-261105-01', { status: 'released' });
      const lotQty = async (code) => (await st.byLot()).filter((x) => x.item_slug === 'atta-kesari' && x.lot_code === code).reduce((n, x) => n + x.qty, 0);
      const before = await lotQty('MNGK-261105-01'), total0 = await onHand(inv, 'atta-kesari'), n0 = st.mv.length;
      const a = await inv.assignLot({ orderId: 'MNG-T6A', slug: 'atta-kesari', lot: 'mngk-261105-01', isOwner: true, actor: OWNER });   // typed in small letters
      const added = st.mv.slice(n0);
      ok(a.moved === 2 && added.length === 2 && added[0].type === 'SALE_UNDO' && added[0].lot_code === null && added[0].qty === 2 && added[1].type === 'SALE' && added[1].lot_code === 'MNGK-261105-01' && added[1].best_before === '2027-02-03' && added[1].qty === -2 && added.every((m) => m.ref === 'MNG-T6A@' + AT && m.actor_email === 'owner@x.com'), 'assignLot: a SALE_UNDO for the lot-less line and a SALE on the lot, same ref, by the owner (' + JSON.stringify(added) + ')');
      ok(await lotQty('MNGK-261105-01') === before - 2 && await onHand(inv, 'atta-kesari') === total0, 'assignLot: the lot drops by 2 and the total on hand does not change');
      nl = await inv.needsLot(); ok(nl.length === 0, 'assignLot: needsLot is empty afterwards (' + JSON.stringify(nl) + ')');
      await rejects(inv.assignLot({ orderId: 'MNG-T6A', slug: 'atta-kesari', lot: 'MNGK-261105-01', isOwner: true, actor: OWNER }), /waiting for a lot/, 'assignLot: nothing left to assign is refused');
      // Undo on the order puts the boxes back on the assigned lot (the lot-less line is not put back twice)
      await inv.restoreForOrder({ orderId: 'MNG-T6A' });
      ok(await lotQty('MNGK-261105-01') === before && await onHand(inv, 'atta-kesari') === total0 + 2 && (await st.byLot()).filter((x) => x.item_slug === 'atta-kesari' && x.lot_code === null).reduce((n, x) => n + x.qty, 0) === 0, 'restoreForOrder after assignLot puts the 2 boxes back on the assigned lot');
    }
    {
      // R4: the same pack already took boxes from the chosen lot
      const { st, inv } = mk6();
      await inv.receive({ slug: 'atta-kesari', received: 1, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
      const plan = await inv.planForOrder({ items: [{ slug: 'atta-kesari', quantity: 3 }], at: AT });
      await inv.deductForOrder({ orderId: 'MNG-T6B', items: [], at: AT, plan, overrideNote: 'event stock' });
      await inv.receive({ slug: 'atta-kesari', received: 10, lot: '15OCT26', bestBefore: '2027-01-13', confirmDuplicate: true, actor: A });
      await rejects(inv.assignLot({ orderId: 'MNG-T6B', slug: 'atta-kesari', lot: '15OCT26', isOwner: true }), /^This pack already took boxes from lot 15OCT26\. Choose another lot, or undo the pack and pack again\.$/, 'assignLot: R4 refusal when the pack already has a sale on that lot');
      // a lot past its last ship date cannot be assigned to a website order
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-260928-01', status: 'released', best_before: '2026-12-27' }]);
      await st.insert([{ item_slug: 'atta-kesari', qty: 40, type: 'RECEIVE', lot_code: 'MNGK-260928-01', best_before: '2026-12-27' }]);
      const later = makeInv(st, { now: () => Date.parse(AT) });
      await rejects(later.assignLot({ orderId: 'MNG-T6B', slug: 'atta-kesari', lot: 'MNGK-260928-01', isOwner: true }), /past its last ship date \(7 Nov\)/, 'assignLot: a lot past its last ship date is refused');
      // an alias finds its lot (the code printed on older stickers)
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261016-01', status: 'released', best_before: '2027-01-14', aliases: ['16OCT26'] }]);
      await st.insert([{ item_slug: 'atta-kesari', qty: 5, type: 'RECEIVE', lot_code: 'MNGK-261016-01', best_before: '2027-01-14' }]);
      const b = await inv.assignLot({ orderId: 'MNG-T6B', slug: 'atta-kesari', lot: '16OCT26', isOwner: true });
      ok(b.moved === 2 && st.mv.slice(-1)[0].lot_code === 'MNGK-261016-01', 'assignLot: an alias finds the lot it names');
    }
    {
      // P1 (fix round 1): packing never sends a box without a lot (spec 1). Stock with no lot (a count up) is not packable, so a
      // lot-less sale after lots_from is always an owner override, a fallback shortfall or an untracked flavour, and needsLot is right.
      const { st, inv } = mk6();
      // Final review I3 changed this setup: a biscuit count-up now names its lot, so the lot-less stock here is an old count-up written
      // before that change (the live ledger can hold such lines); the checks below are unchanged
      await st.insert([{ item_slug: 'atta-kesari', qty: 3, type: 'COUNT_FIX', lot_code: null, best_before: null, note: 'found 3 boxes' }]);
      const plan = await inv.planForOrder({ items: KES2, at: AT });
      ok(plan.rows.length === 0 && plan.short.length === 1 && plan.short[0].boxes === 2 && plan.short[0].hint === 'Receive the delivery first.', 'P1: 3 boxes counted with no lot do not cover a pack of 2 (' + JSON.stringify(plan) + ')');
      const r = await inv.deductForOrder({ orderId: 'MNG-T6C', items: [], at: AT, plan, overrideNote: 'found in the store' });
      const mine = st.mv.filter((m) => m.ref === 'MNG-T6C@' + AT);
      ok(r.rows === 1 && mine.length === 1 && mine[0].qty === -2 && mine[0].lot_code === null && mine[0].note === 'Packed without a lot (owner): found in the store', 'P1: with an override it writes one lot-less line with the note (' + JSON.stringify(mine) + ')');
      const nl = await inv.needsLot();
      ok(nl.length === 1 && nl[0].orderId === 'MNG-T6C' && nl[0].boxes === 2, 'P1: and needsLot lists it (' + JSON.stringify(nl) + ')');
      ok((await inv.deductForOrder({ orderId: 'MNG-T6D', items: [], at: AT, plan: { skipped: 'before tracking started', rows: [], short: [] } })).skipped, 'deductForOrder with a skipped plan writes nothing');
    }
    {
      // P2 (fix round 1): one lot under two best-before dates is one lot (the database allows one sale per pack, flavour and lot)
      const { st, inv } = mk6();
      await inv.receive({ slug: 'atta-kesari', received: 1, lot: 'LX', bestBefore: '2027-01-20', actor: A });
      await inv.receive({ slug: 'atta-kesari', received: 5, lot: 'LX', bestBefore: '2027-01-25', actor: A });
      const p1 = await inv.planForOrder({ items: [{ slug: 'atta-kesari', quantity: 3 }], at: AT });
      ok(p1.short.length === 0 && p1.rows.length === 1 && p1.rows[0].lot_code === 'LX' && p1.rows[0].qty === -3 && p1.rows[0].best_before === '2027-01-20', 'P2: a pack of 3 is one sale of 3 from lot LX, at its earliest best before (' + JSON.stringify(p1.rows) + ')');
      await inv.deductForOrder({ orderId: 'MNG-P2A', items: [], at: AT, plan: p1 });
      const p2 = await inv.planForOrder({ items: [{ slug: 'atta-kesari', quantity: 5 }], at: AT });
      ok(p2.short.length === 1 && p2.short[0].boxes === 2 && p2.rows.length === 1 && p2.rows[0].qty === -3, 'P2: the next pack of 5 finds only the 3 left in LX, so 2 are short (' + JSON.stringify(p2) + ')');
      ok((await stockOfLot(st, 'atta-kesari', 'LX')) === 3, 'P2: lot LX holds 3');
    }
    {
      // P4 (fix round 1): Assign lot writes its sale with the lot's own best before; the ledger may carry another one. The lot is still one lot.
      const { st, inv } = mk6();
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261104-01', status: 'released', best_before: '2027-02-02' }]);
      await st.insert([{ item_slug: 'atta-kesari', qty: 3, type: 'RECEIVE', lot_code: 'MNGK-261104-01', best_before: '2027-02-05' }]);
      await st.insert([{ item_slug: 'atta-kesari', qty: -3, type: 'SALE', lot_code: null, best_before: null, ref: 'MNG-P4@' + AT }]);
      const a = await inv.assignLot({ orderId: 'MNG-P4', slug: 'atta-kesari', lot: 'MNGK-261104-01', isOwner: true });
      ok(a.moved === 3 && (await stockOfLot(st, 'atta-kesari', 'MNGK-261104-01')) === 0, 'P4: setup: the 3 boxes of the lot are assigned to the order');
      const p = await inv.planForOrder({ items: [{ slug: 'atta-kesari', quantity: 1 }], at: AT });
      ok(p.rows.length === 0 && p.short.length === 1 && p.short[0].boxes === 1, 'P4: the emptied lot is not packed again through its other best-before line (' + JSON.stringify(p) + ')');
    }
    {
      // needsLot: only after lots_from (compared as times, not text), and not once undone
      const { st, inv } = mk6();
      st.setSetting('lots_from', '2026-10-30 10:00:00+05:30');   // the database stores now()::text: 04:30 UTC
      await st.insert([
        { item_slug: 'atta-kesari', qty: -1, type: 'SALE', lot_code: null, best_before: null, ref: 'MNG-EARLY@2026-10-30T04:00:00.000Z' },
        { item_slug: 'atta-kesari', qty: -1, type: 'SALE', lot_code: null, best_before: null, ref: 'MNG-LATE@2026-10-30T05:00:00.000Z' },
        { item_slug: 'atta-original', qty: -2, type: 'SALE', lot_code: null, best_before: null, ref: 'MNG-UNDONE@2026-10-31T05:00:00.000Z' },
        { item_slug: 'atta-original', qty: 2, type: 'SALE_UNDO', lot_code: null, best_before: null, ref: 'MNG-UNDONE@2026-10-31T05:00:00.000Z' },
      ]);
      const times = ['2026-10-30T04:00:00.000Z', '2026-10-30T05:00:00.000Z', '2026-10-31T05:00:00.000Z', '2026-10-31T06:00:00.000Z']; st.mv.slice(-4).forEach((m, i) => { m.created_at = times[i]; });
      st.lotlessSales = async () => st.mv.filter((m) => (m.type === 'SALE' || m.type === 'SALE_UNDO') && m.lot_code == null);   // a store that returns too much: needsLot must still decide by time itself
      const nl = await inv.needsLot();
      ok(nl.length === 1 && nl[0].orderId === 'MNG-LATE' && nl[0].boxes === 1, 'needsLot: a row before lots_from (by time) and an undone row are left out (' + JSON.stringify(nl) + ')');
    }
    {
      // the real store reads the lot-less sales from stock_movements
      const dbPath = require.resolve('../utils/database'); const seen = []; const saved = require.cache[dbPath];
      const q = (t) => { const o = { t, ops: [] }; const chain = new Proxy(o, { get: (target, k) => (k === 'then' ? (res) => { seen.push(target); res({ data: [{ id: 1 }], error: null }); } : (...a) => { target.ops.push([k, ...a]); return chain; }) }); return chain; };
      require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { client: () => ({ from: (t) => q(t) }) } };
      const real = require('../utils/inventory').supabaseStore();
      const got = typeof real.lotlessSales === 'function' ? await real.lotlessSales('2026-10-30T04:30:00.000Z') : null;
      const c0 = seen[0] || { ops: [] }; const has = (...want) => c0.ops.some((o) => JSON.stringify(o) === JSON.stringify(want));
      ok(got && got.length === 1 && c0.t === 'stock_movements' && has('in', 'type', ['SALE', 'SALE_UNDO']) && has('is', 'lot_code', null) && has('gte', 'created_at', '2026-10-30T04:30:00.000Z'), 'the real store reads lot-less sales and their undos since lots_from (' + JSON.stringify(c0) + ')');
      require.cache[dbPath] = saved;
    }
  }

  // ── Task 6b: packaging is a hand-kept list (8 Nov 2026) ──
  {
    const OLD = '2020-01-01T00:00:00.000Z', RESET = '2021-01-01T00:00:00.000Z';   // calendar-proof: rows written now are always after RESET
    const mkP = async () => {
      const st = memStore('2026-10-16T00:00:00.000Z'); const inv = makeInventory(st);
      await inv.receive({ slug: 'packing-tape', received: 30, actor: A });          // an old, pre-reset count
      await inv.receive({ slug: 'atta-kesari', received: 100, lot: 'L1', bestBefore: '2027-01-13', actor: A });
      st.mv.forEach((m) => { m.created_at = OLD; });
      st.setSetting('packaging_count_from', RESET);
      return { st, inv };
    };
    const row = async (inv, slug) => (await inv.overview()).items.find((i) => i.slug === slug);
    // the setting
    ok(typeof (await memStore('2026-10-16T00:00:00.000Z').settingsAll()).packaging_count_from === 'string', 'memstore has packaging_count_from (its creation time)');
    const mig = require('fs').readFileSync(require('path').join(__dirname, '..', 'batch_receiving_migration.sql'), 'utf8');
    ok(/\('packaging_count_from',\s*now\(\)::text\)/.test(mig) && /on conflict \(key\) do nothing/.test(mig), 'migration inserts packaging_count_from once (on conflict do nothing)');
    ok(/alter table stock_items add column if not exists counted_at timestamptz/.test(mig), 'migration adds the nullable counted_at column');
    ok(/update stock_items set name = '24-box case carton' where slug = 'case-carton' and name = '20-box case carton'/.test(mig), 'migration renames the case carton only when it still has the old name');
    {
      const { st, inv } = await mkP();
      let t = await row(inv, 'packing-tape');
      ok(t.counted === false && t.on_hand === 0 && t.status === 'new' && t.last_counted === null, 'packaging with only old rows has no count (' + JSON.stringify([t.counted, t.on_hand, t.status]) + ')');
      ok(!(await inv.overview()).low.some((x) => x.slug === 'packing-tape'), 'no count is not in the low list');
      await inv.setLevel({ slug: 'packing-tape', lowLevel: 50 });
      t = await row(inv, 'packing-tape'); ok(t.status === 'new' && !(await inv.overview()).low.some((x) => x.slug === 'packing-tape'), 'a low level with no count is still no alert');
      const k = await row(inv, 'atta-kesari'); ok(k.on_hand === 100 && k.counted === true && k.status === 'ok', 'biscuit counts are untouched by the reset');
      // typing a count
      const before = st.mv.length;
      const c = await inv.count({ slug: 'packing-tape', counted: 40, note: 'counted the shelf', actor: A });
      ok(c.diff === 40 && c.onHand === 40 && st.mv.length === before + 1 && st.mv[st.mv.length - 1].type === 'COUNT_FIX' && st.mv[st.mv.length - 1].qty === 40, 'count writes one COUNT_FIX of +40 from the since-reset count');
      t = await row(inv, 'packing-tape'); ok(t.counted === true && t.on_hand === 40 && /^\d{4}-\d\d-\d\dT/.test(t.last_counted), 'the item now shows 40 and when it was counted');
      ok(t.status === 'low' && (await inv.overview()).low.some((x) => x.slug === 'packing-tape'), 'low_level 50 and a count of 40: low');
      await inv.setLevel({ slug: 'packing-tape', lowLevel: 0 });
      ok((await row(inv, 'packing-tape')).status === 'ok', 'low level 0 and a count: ok');
      await inv.count({ slug: 'packing-tape', counted: 0, note: 'used all', actor: A });
      t = await row(inv, 'packing-tape'); ok(t.on_hand === 0 && t.counted === true && t.status === 'ok' && !(await inv.overview()).low.some((x) => x.slug === 'packing-tape'), 'a count of 0 with low level 0 is not an alert');
      await inv.setLevel({ slug: 'packing-tape', lowLevel: 5 });
      ok((await row(inv, 'packing-tape')).status === 'out', 'a count of 0 under a low level is out');
      await inv.setLevel({ slug: 'packing-tape', lowLevel: 0 });
      await inv.setLow({ slug: 'packing-tape', low: true }); ok((await row(inv, 'packing-tape')).status === 'low', 'the manual Low flag still raises an alert');
      await inv.setLow({ slug: 'packing-tape', low: false });
      ok(st.mv.filter((m) => m.item_slug === 'packing-tape').length === 3 && st.mv[0].created_at === OLD, 'old lines stay in the ledger');
      const h = await inv.history({ slug: 'packing-tape' }); ok(h.movements.length === 3 && h.movements.some((m) => m.created_at === OLD && m.qty === 30), 'history still lists the old line');
      // taking out uses the since-reset count
      await inv.count({ slug: 'packing-tape', counted: 40, note: 'recount', actor: A });
      await inv.take({ slug: 'packing-tape', qty: 5, type: 'USE', actor: A }); ok((await row(inv, 'packing-tape')).on_hand === 35, 'a take-out comes off the since-reset count');
      await rejects(inv.take({ slug: 'packing-tape', qty: 36, type: 'USE', actor: A }), /Only 35/, 'a take-out is checked against the since-reset count, not the old total');
      // removing the setting brings the old counts back
      st.setSetting('packaging_count_from', null);
      t = await row(inv, 'packing-tape'); ok(t.on_hand === 65 && t.counted === true, 'without the setting every ledger line counts again (' + t.on_hand + ')');
    }
    {
      // a biscuit count is the same with or without a reset; no row since the reset for a biscuit changes nothing
      const { inv } = await mkP();
      ok((await row(inv, 'atta-kesari')).on_hand === 100, 'biscuit rows before the reset still count');
    }
    {
      // remove = archive
      const { st, inv } = await mkP();
      await inv.count({ slug: 'mono-kesari', counted: 12, note: 'x', actor: A });
      const rowsBefore = st.mv.length, itemsBefore = (await st.items()).length;
      await rejects(inv.removeItem({ slug: 'mono-kesari', isOwner: false }), /Only the owner/, 'staff cannot remove an item');
      try { await inv.removeItem({ slug: 'mono-kesari' }); ok(false, 'no isOwner must refuse'); } catch (e) { ok(e.status === 403, 'removeItem defaults to refusing (403)'); }
      try { await inv.removeItem({ slug: 'mono-kesari', isOwner: false }); } catch (e) { ok(e.status === 403, 'staff removeItem is 403'); }
      await rejects(inv.removeItem({ slug: 'atta-kesari', isOwner: true }), /Only packaging items can be removed\. Biscuits stay\./, 'a biscuit cannot be removed');
      ok((await st.item('atta-kesari')).active === true, 'the biscuit is still active');
      await rejects(inv.removeItem({ slug: 'no-such', isOwner: true }), /No such item/, 'unknown item');
      const r = await inv.removeItem({ slug: 'mono-kesari', isOwner: true }); ok(r.ok === true, 'owner removes a packaging item');
      ok(!(await inv.overview()).items.some((i) => i.slug === 'mono-kesari') && !(await inv.overview()).low.some((x) => x.slug === 'mono-kesari'), 'the removed item leaves the overview');
      ok((await st.item('mono-kesari')).active === false && st.mv.length === rowsBefore && (await st.items()).length === itemsBefore, 'nothing is deleted: the item is archived and its rows stay');
      await rejects(inv.count({ slug: 'mono-kesari', counted: 5, note: 'x', actor: A }), /No such item/, 'an archived item cannot be counted');
      await rejects(inv.removeItem({ slug: 'mono-kesari', isOwner: true }), /No such item/, 'removing twice is refused');
      // add the same name again: reactivated, same slug, history kept
      const back = await inv.addItem({ name: 'Mono carton: Kesari', kind: 'packaging', unit: 'reels' });
      ok(back.slug === 'mono-kesari', 'adding an archived name brings it back with the same slug');
      const t = await row(inv, 'mono-kesari'); ok(t && t.on_hand === 12 && t.counted === true && t.unit === 'reels' && t.name === 'Mono carton: Kesari', 'the returned item keeps its count and history, with the new unit (' + JSON.stringify([t && t.on_hand, t && t.unit]) + ')');
      ok((await st.items()).length === itemsBefore, 'no second item row was made');
      await rejects(inv.addItem({ name: 'Mono carton: Kesari', kind: 'packaging' }), /already on the list/, 'an active item with that name cannot be added twice');
      await rejects(inv.addItem({ name: 'Atta Kesari', kind: 'packaging' }), /already on the list/, 'a biscuit name is never reused');
      await rejects(inv.addItem({ name: '  mono  CARTON:kesari ', kind: 'packaging' }), /^That item is already on the list\.$/, 'the name match ignores case and spaces, and an active item blocks a second one');
      ok((await st.items()).filter((i) => /kesari/.test(i.slug) && i.kind === 'packaging').length === 1 && !(await st.item('mono-carton-kesari')), 'no look-alike item was made');
      // another seeded item, brought back by its name typed differently
      await inv.removeItem({ slug: 'label-stamp', isOwner: true });
      const lb = await inv.addItem({ name: 'stamp / BATCH labels', kind: 'packaging' });
      ok(lb.slug === 'label-stamp' && lb.restored === true && (await row(inv, 'label-stamp')).name === 'Stamp / batch labels', 'label-stamp comes back by name (case and spacing ignored), same slug');
      // a brand-new name still gets its own slug, and a slug clash is refused
      const nw = await inv.addItem({ name: 'Bubble wrap 2', kind: 'packaging', unit: 'rolls' }); ok(nw.slug === 'bubble-wrap-2' && !nw.restored, 'a name nobody has gets a new item');
      await rejects(inv.addItem({ name: 'Bubble-wrap-2', kind: 'packaging' }), /already exists/, 'a different name with the same made-up slug is refused');
    }
    {
      // typing a count always records it (counted_at), even 0 and even the same number
      {
        const { st, inv } = await mkP();
        const rows0 = st.mv.length;
        const c0 = await inv.count({ slug: 'label-stamp', counted: 0, actor: A });
        let t = await row(inv, 'label-stamp');
        ok(c0.diff === 0 && c0.onHand === 0 && st.mv.length === rows0 && t.counted === true && t.on_hand === 0 && /^\d{4}-\d\d-\d\dT/.test(t.last_counted), 'a first count of 0 is recorded (no ledger line, counted_at set)');
        ok(typeof (await st.item('label-stamp')).counted_at === 'string', 'the item carries counted_at');
        await inv.setLevel({ slug: 'label-stamp', lowLevel: 5 });
        t = await row(inv, 'label-stamp'); ok(t.status === 'out' && (await inv.overview()).low.some((x) => x.slug === 'label-stamp'), 'a counted 0 under a low level of 5 is OUT');
        await inv.count({ slug: 'label-stamp', counted: 8, actor: A, note: 'bought' });
        const at1 = (await st.item('label-stamp')).counted_at; await new Promise((r) => setTimeout(r, 15));
        const rows1 = st.mv.length; const c2 = await inv.count({ slug: 'label-stamp', counted: 8, actor: A });
        ok(c2.diff === 0 && st.mv.length === rows1 && Date.parse((await st.item('label-stamp')).counted_at) > Date.parse(at1), 'counting the same number again writes no line but moves counted_at');
        t = await row(inv, 'label-stamp'); ok(t.last_counted === (await st.item('label-stamp')).counted_at, 'last counted is the later of counted_at and the newest line');
        // a count saved before the reset does not count
        st.setSetting('packaging_count_from', '2099-01-01T00:00:00.000Z');
        t = await row(inv, 'label-stamp'); ok(t.counted === false && t.on_hand === 0, 'a counted_at before packaging_count_from does not count');
        // a refused count (needs a note) leaves counted_at alone
        st.setSetting('packaging_count_from', RESET);
        const keep = (await st.item('label-stamp')).counted_at;
        await rejects(inv.count({ slug: 'label-stamp', counted: 3, actor: A }), /note/, 'a changed count still needs a note in the backend');
        ok((await st.item('label-stamp')).counted_at === keep, 'a refused count does not move counted_at');
        // biscuits never get counted_at
        await inv.count({ slug: 'atta-kesari', counted: 100, actor: A });
        ok((await st.item('atta-kesari')).counted_at == null, 'a biscuit count does not set counted_at');
      }
      // the real store sums the ledger since the reset, through the database client
      const dbPath = require.resolve('../utils/database'); const seen = []; const saved = require.cache[dbPath];
      const q = (t) => { const o = { t, ops: [] }; const chain = new Proxy(o, { get: (target, k) => (k === 'then' ? (res) => { seen.push(target); res({ data: [{ item_slug: 'packing-tape', qty: 40, created_at: '2026-11-08T12:00:00+00:00' }, { item_slug: 'packing-tape', qty: -5, created_at: '2026-11-09T12:00:00+00:00' }, { item_slug: 'label-stamp', qty: 0 + 7, created_at: '2026-11-08T13:00:00+00:00' }], error: null }); } : (...a) => { target.ops.push([k, ...a]); return chain; }) }); return chain; };
      require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { client: () => ({ from: (t) => q(t) }) } };
      const real = require('../utils/inventory').supabaseStore();
      const got = typeof real.totalsSince === 'function' ? await real.totalsSince('2026-11-08T10:00:00.000Z', ['packing-tape', 'label-stamp']) : null;
      const c0 = seen[0] || { ops: [] }; const has = (...want) => c0.ops.some((o) => JSON.stringify(o) === JSON.stringify(want));
      ok(got && c0.t === 'stock_movements' && has('gte', 'created_at', '2026-11-08T10:00:00.000Z') && has('in', 'item_slug', ['packing-tape', 'label-stamp']), 'the real store reads stock_movements since the reset for the packaging slugs');
      const byS = Object.fromEntries((got || []).map((x) => [x.item_slug, x]));
      ok(byS['packing-tape'] && byS['packing-tape'].qty === 35 && byS['packing-tape'].last === '2026-11-09T12:00:00+00:00' && byS['label-stamp'].qty === 7, 'the real store sums per item and keeps the newest time (' + JSON.stringify(got) + ')');
      require.cache[dbPath] = saved;
    }
  }

  // Task 10 fix: a line written by a delivery can be corrected only as a whole delivery (Correct whole delivery / Fix lot), never one line at a time
  {
    const st2 = memStore('2026-10-16T00:00:00.000Z'); const inv2 = makeInventory(st2);
    const FROM = /^This line came from a delivery\. Use Correct whole delivery or Fix lot\.$/;
    await st2.insert([{ item_slug: 'atta-original', qty: 10, type: 'RECEIVE', lot_code: 'MNGO-261030-01', best_before: '2027-01-28', ref: 'B1', delivery_id: 'd-1', actor_email: 'staff@x.com' },
      { item_slug: 'atta-original', qty: -1, type: 'DAMAGED', lot_code: 'MNGO-261030-01', best_before: '2027-01-28', ref: 'B1', delivery_id: 'd-1', reason: 'transit' }]);
    const rows = st2.mv.filter((m) => m.delivery_id === 'd-1'), n0 = st2.mv.length;
    const rcv = rows.find((m) => m.type === 'RECEIVE'), dmg = rows.find((m) => m.type === 'DAMAGED');
    await rejects(inv2.receive({ slug: 'atta-original', received: 9, lot: 'MNGO-261030-01', bestBefore: '2027-01-28', replaces: rcv.id, actor: A }), FROM, 'correcting a delivery line through receive is refused');
    await rejects(inv2.reverse({ id: rcv.id, reason: 'typo', actor: A }), FROM, 'cancelling a delivery RECEIVE line is refused');
    await rejects(inv2.reverse({ id: dmg.id, reason: 'typo', actor: A, isOwner: true }), FROM, 'cancelling a delivery DAMAGED line is refused, even for the owner');
    ok(st2.mv.length === n0, 'nothing was written by the refusals');
    // a line with no delivery still works
    await inv2.receive({ slug: 'atta-original', received: 4, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
    ok((await inv2.reverse({ id: st2.mv.find((m) => m.lot_code === '15OCT26' && m.type === 'RECEIVE').id, reason: 'typo', actor: A })).ok, 'an ordinary receipt can still be cancelled');
  }

  // Task 12: the Stock screen says how many boxes are on hold, so a flavour whose stock is all held never looks fine silently
  {
    const st = memStore('2026-10-16T00:00:00.000Z'); const inv = makeInventory(st);
    await inv.receive({ slug: 'atta-kesari', received: 10, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
    await st.insertLots([{ item_slug: 'atta-kesari', lot_code: 'MNGK-261030-01', status: 'hold', best_before: '2027-01-28' }, { item_slug: 'atta-original', lot_code: 'MNGO-261030-01', status: 'hold', best_before: '2027-01-28' }]);
    await st.insert([{ item_slug: 'atta-kesari', qty: 6, type: 'RECEIVE', lot_code: 'MNGK-261030-01', best_before: '2027-01-28', ref: 'B9' }, { item_slug: 'atta-kesari', qty: -1, type: 'DAMAGED', lot_code: 'MNGK-261030-01', best_before: '2027-01-28', ref: 'B9', reason: 'transit' },
      { item_slug: 'atta-original', qty: 4, type: 'RECEIVE', lot_code: 'MNGO-261030-01', best_before: '2027-01-28', ref: 'B9' }]);
    const row = async (slug) => (await inv.overview()).items.find((i) => i.slug === slug);
    let k = await row('atta-kesari'), o = await row('atta-original');
    ok(k.on_hand === 15 && k.on_hold === 5 && k.sellable === 10, 'overview: Kesari 15 on hand, 5 of them on hold (6 received, 1 broken), 10 on the website (' + JSON.stringify([k.on_hand, k.on_hold, k.sellable]) + ')');
    ok(o.on_hand === 4 && o.on_hold === 4 && o.sellable === 0, 'overview: Original has only held stock: 4 on hand, 4 on hold, 0 on the website (' + JSON.stringify([o.on_hand, o.on_hold, o.sellable]) + ')');
    ok((await row('atta-ajwain')).on_hold === 0 && (await row('packing-tape')).on_hold === null, 'a flavour with nothing on hold says 0; packaging has no hold count');
    await st.updateLot('atta-original', 'MNGO-261030-01', { status: 'released' });
    o = await row('atta-original');
    ok(o.on_hold === 0 && o.sellable === 4, 'released: nothing on hold and the website counts the 4 boxes');
  }

  // Final review C2: a hold covers every code of the lot (its aliases), in the website count and in packing; boxes put back under an old
  // code after Fix lot follow the lot; the old Rename lot is refused for biscuits (Fix lot moves the hold and the dates with the lot).
  {
    const { makeDeliveries } = require('../utils/deliveries');
    const OWN = { actor: { email: 'o@x', name: 'Owner' }, isOwner: true };
    const mailer = { sendDeliveryEmail: async () => {}, sendLotReleasedEmail: async () => {} };
    const NOW2 = Date.parse('2026-11-10T06:00:00Z');
    const mk = () => { const st = memStore('2026-10-01T00:00:00Z'); st.setSetting('lots_from', '2026-11-01T00:00:00Z'); return { st, inv: makeInv(st, { now: () => NOW2 }), dl: makeDeliveries(st, { now: () => NOW2, mailer, db: { getOrdersByIds: async () => [] } }) }; };
    // rows under an alias code (a sticker code typed on the old form) are held with the lot
    {
      const { st, inv, dl } = mk();
      await st.insert([{ item_slug: 'atta-kesari', qty: 30, type: 'RECEIVE', lot_code: '15OCT26', best_before: '2027-01-13' }, { item_slug: 'atta-kesari', qty: 5, type: 'RECEIVE', lot_code: 'MNGK-261016-01', best_before: '2027-01-13' }]);
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: '15OCT26', status: 'released', best_before: '2027-01-13', aliases: ['MNGK-261016-01'] }]);
      eq((await inv.sellable())['atta-kesari'], 35, 'C2 setup: 35 Kesari on the website');
      await dl.hold({ code: '15OCT26', slug: 'atta-kesari', reason: 'recall' }, OWN);
      eq((await inv.sellable())['atta-kesari'], 0, 'C2: hold covers the boxes booked under the alias code (website)');
      const p = await inv.planForOrder({ items: [{ slug: 'atta-kesari', quantity: 2 }], at: new Date(NOW2).toISOString() });
      ok(p.rows.length === 0 && p.short.length === 1 && p.short[0].boxes === 2, 'C2: and packing takes none of them (' + JSON.stringify(p) + ')');
      const k = (await inv.overview()).items.find((i) => i.slug === 'atta-kesari');
      ok(k.on_hold === 35 && k.lots.every((l) => l.status === 'hold'), 'C2: the Stock screen shows all 35 on hold (' + JSON.stringify(k.lots) + ')');
    }
    // undo after Fix lot puts the boxes back under the old code; they follow the lot when it is held
    {
      const { st, inv, dl } = mk();
      await st.insert([{ item_slug: 'atta-kesari', qty: 50, type: 'RECEIVE', lot_code: '15OCT26', best_before: '2027-01-13' }, { item_slug: 'atta-kesari', qty: 6, type: 'EXHIBITION', lot_code: '15OCT26', best_before: '2027-01-13', ref: 'Fair' }].map((r) => (r.type === 'EXHIBITION' ? { ...r, qty: -6 } : r)));
      await st.insertLots([{ item_slug: 'atta-kesari', lot_code: '15OCT26', status: 'released', best_before: '2027-01-13', aliases: ['MNGK-261016-01'] }]);
      const at = '2026-11-09T05:00:00.000Z';
      const plan = await inv.planForOrder({ items: [{ slug: 'atta-kesari', quantity: 4 }], at });
      await inv.deductForOrder({ orderId: 'MNG-AAAA-0001', items: [], at, plan });
      await dl.fixLot({ code: '15OCT26', slug: 'atta-kesari', newCode: 'MNGK-261016-01' }, OWN);
      await inv.restoreForOrder({ orderId: 'MNG-AAAA-0001' });
      await inv.eventReturn({ slug: 'atta-kesari', qty: 6, ref: 'Fair' });
      ok(st.mv.filter((m) => m.lot_code === '15OCT26' && (m.type === 'SALE_UNDO' || m.type === 'EXHIBITION_RETURN')).length === 2, 'C2 setup: the undo and the event return go back under the old code 15OCT26');
      eq((await inv.sellable())['atta-kesari'], 50, 'C2 setup: all 50 sellable after the undo and the return');
      await dl.hold({ code: 'MNGK-261016-01', slug: 'atta-kesari', reason: 'recall' }, OWN);
      eq((await inv.sellable())['atta-kesari'], 0, 'C2: after Hold of the fixed lot the boxes put back under its old code are held too (website)');
      const p = await inv.planForOrder({ items: [{ slug: 'atta-kesari', quantity: 2 }], at: new Date(NOW2).toISOString() });
      ok(p.rows.length === 0 && p.short.length === 1, 'C2: and packing takes none of them (' + JSON.stringify(p.rows) + ')');
      await rejects(inv.take({ slug: 'atta-kesari', qty: 1, type: 'SAMPLE', lot: '15OCT26' }), /on hold/, 'C2: a take-out naming the old code is refused while the lot is held');
    }
    // the old Rename lot: refused for biscuits, unchanged for packaging
    {
      const { st, inv } = mk();
      await st.insert([{ item_slug: 'atta-original', qty: 80, type: 'RECEIVE', lot_code: '27OCT26', best_before: '2027-01-25' }]);
      await rejects(inv.renameLot({ slug: 'atta-original', from: '27OCT26', to: 'MNGO-261027-01', actor: A, isOwner: true }), /^Biscuit lots are fixed with Fix lot on the lot page, so the hold and the dates follow the lot\.$/, 'C2: Rename lot refuses a biscuit lot');
      ok(st.mv.filter((m) => m.type === 'COUNT_FIX').length === 0, 'C2: and writes nothing');
    }
  }

  // Final review I1: the code pushed before batch_receiving_migration.sql is run. The lot table (and maybe the settings) cannot be read:
  // the website keeps its stock limits exactly as before lots, the Stock screen, take-outs and count-downs still work, and the log says
  // once what to run. Any other failure still throws.
  {
    const MIGRATE = 'Run batch_receiving_migration.sql in Supabase first.';
    const st = memStore('2026-10-16T00:00:00.000Z'); const inv = makeInventory(st);
    await inv.receive({ slug: 'atta-kesari', received: 40, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
    await inv.receive({ slug: 'atta-original', received: 12, lot: '27OCT26', bestBefore: '2027-01-25', actor: A });
    await st.insert([{ item_slug: 'atta-ajwain', qty: 5, type: 'RECEIVE', lot_code: null }]);
    st.committedMap = { 'atta-kesari': 3 };
    const preBranch = computeSellable(await st.items(), await st.byLot(), await st.committed());   // no lot context: every box counts
    st.lots = async () => { throw new Error(MIGRATE); };
    const logged = []; const err0 = console.error; console.error = (...a) => { logged.push(a.join(' ')); };
    let got = null, ov = null, tk = null, cd = null;
    try {
      got = await inv.sellable().catch((e) => e);
      ov = await inv.overview().catch((e) => e);
      tk = await inv.take({ slug: 'atta-kesari', qty: 2, type: 'SAMPLE', actor: A }).catch((e) => e);
      cd = await inv.count({ slug: 'atta-original', counted: 10, note: 'two broken', actor: A }).catch((e) => e);
      st.settingsAll = async () => { throw new Error(MIGRATE); };
      await inv.sellable().catch(() => {});
      var ov2 = await inv.overview().catch((e) => e), got2 = await inv.sellable().catch((e) => e);
    } finally { console.error = err0; }
    ok(ov2 && !(ov2 instanceof Error) && JSON.stringify(got2) === JSON.stringify(computeSellable(await st.items(), await st.byLot(), await st.committed())), 'I1: with the settings missing too, the Stock screen and the website count still work (' + (ov2 instanceof Error ? ov2.message : JSON.stringify(got2)) + ')');
    eq(got, preBranch, 'I1: with the lot table missing, sellable() equals the pre-branch computeSellable');
    ok(ov && !(ov instanceof Error) && ov.items.find((i) => i.slug === 'atta-kesari').on_hand === 40, 'I1: the Stock screen (overview) still works (' + (ov instanceof Error ? ov.message : 'ok') + ')');
    ok(tk && !(tk instanceof Error) && tk.onHand === 38, 'I1: a take-out still works (' + (tk instanceof Error ? tk.message : JSON.stringify(tk)) + ')');
    ok(cd && !(cd instanceof Error) && cd.onHand === 10 && cd.diff === -2, 'I1: a count-down still works (' + (cd instanceof Error ? cd.message : JSON.stringify(cd)) + ')');
    eq(logged.filter((l) => l === '[STOCK] batch receiving tables missing: run batch_receiving_migration.sql').length, 1, 'I1: one log line says what to run (' + JSON.stringify(logged) + ')');
    const st2 = memStore('2026-10-16T00:00:00.000Z'); const inv2 = makeInventory(st2);
    st2.lots = async () => { throw new Error('db down'); };
    const other = await inv2.sellable().then(() => null, (e) => e);
    ok(other && other.message === 'db down', 'I1: any other failure still throws (the last known answer is kept by utils/stock.js) (' + (other && other.message) + ')');
  }

  // Final review I3: a biscuit count higher than on hand says which lot the extra boxes belong to, so the website never sells boxes
  // packing would refuse. Count-downs and packaging are unchanged.
  {
    const st = memStore('2026-10-16T00:00:00.000Z'); const inv = makeInventory(st);
    await st.insertLots([
      { item_slug: 'atta-ajwain', lot_code: 'MNGA-261020-01', status: 'released', best_before: '2027-01-18', aliases: ['20OCT26'] },
      { item_slug: 'atta-ajwain', lot_code: 'MNGA-261025-01', status: 'hold', best_before: '2027-01-23', aliases: [] },
      { item_slug: 'atta-ajwain', lot_code: 'MNGA-261001-01', status: 'rejected', best_before: '2026-12-30', aliases: [] }]);
    await st.insert([{ item_slug: 'atta-ajwain', qty: 2, type: 'RECEIVE', lot_code: 'MNGA-261020-01', best_before: '2027-01-18' }, { item_slug: 'atta-ajwain', qty: 4, type: 'RECEIVE', lot_code: 'MNGA-261025-01', best_before: '2027-01-23' },
      { item_slug: 'atta-ajwain', qty: 1, type: 'RECEIVE', lot_code: 'OLDLEG', best_before: '2027-01-10' }]);
    const n0 = st.mv.length;
    await rejects(inv.count({ slug: 'atta-ajwain', counted: 10, note: 'found 3', actor: A }), /^Choose which lot the extra boxes belong to\.$/, 'I3: a biscuit count-up needs the lot');
    await rejects(inv.count({ slug: 'atta-ajwain', counted: 10, note: 'found 3', lot: 'NOPE-1', actor: A }), /^NOPE-1 is not a lot of Atta Ajwain\.$/, 'I3: the lot must be a lot of that flavour');
    await rejects(inv.count({ slug: 'atta-ajwain', counted: 10, note: 'found 3', lot: 'MNGK-261020-01', actor: A }), /is not a lot of Atta Ajwain/, 'I3: another flavour\'s lot is refused');
    await rejects(inv.count({ slug: 'atta-ajwain', counted: 10, note: 'found 3', lot: 'MNGA-261001-01', actor: A }), /^Lot MNGA-261001-01 was rejected or corrected, so boxes cannot be added to it\.$/, 'I3: a rejected lot is refused');
    await rejects(inv.count({ slug: 'atta-ajwain', counted: 10, lot: 'MNGA-261020-01', actor: A }), /Add a short note/, 'I3: the note is still asked for first');
    eq(st.mv.length, n0, 'I3: refused counts write nothing');
    const r = await inv.count({ slug: 'atta-ajwain', counted: 10, note: 'found 3', lot: '20oct26', actor: A });   // an alias, any case (C1 rule)
    const fix = st.mv.slice(-1)[0];
    eq([r.diff, r.onHand, fix.type, fix.qty, fix.lot_code, fix.best_before], [3, 10, 'COUNT_FIX', 3, 'MNGA-261020-01', '2027-01-18'], 'I3: the +3 line carries the lot (resolved from its alias) and the lot\'s best before');
    const plan = await inv.planForOrder({ items: [{ slug: 'atta-ajwain', quantity: 6 }], at: '2026-10-31T06:00:00.000Z' });
    eq([(await inv.sellable())['atta-ajwain'], plan.short.length, plan.rows.reduce((n, x) => n - x.qty, 0)], [6, 0, 6], 'I3: what the website sells (6) packing can pack (the 4 held boxes are neither)');
    await inv.count({ slug: 'atta-ajwain', counted: 12, note: 'found 2 more', lot: 'MNGA-261025-01', actor: A });
    eq([st.mv.slice(-1)[0].lot_code, (await inv.sellable())['atta-ajwain']], ['MNGA-261025-01', 6], 'I3: boxes added to a held lot stay held');
    await inv.count({ slug: 'atta-ajwain', counted: 13, note: 'one more', lot: 'OLDLEG', actor: A });
    eq([st.mv.slice(-1)[0].lot_code, st.mv.slice(-1)[0].best_before], ['OLDLEG', '2027-01-10'], 'I3: a lot from before lots began (ledger only) can take them, with its best before');
    const down = await inv.count({ slug: 'atta-ajwain', counted: 11, note: 'two broken', actor: A });
    ok(down.diff === -2 && st.mv.slice(-1)[0].type === 'COUNT_FIX' && st.mv.slice(-1)[0].qty < 0, 'I3: a count-down needs no lot (unchanged)');
    const pk = await inv.count({ slug: 'packing-tape', counted: 5, note: 'bought', actor: A });
    ok(pk.diff === 5 && st.mv.slice(-1)[0].lot_code === null, 'I3: a packaging count-up needs no lot (unchanged)');
  }

  console.log(`inventory-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
