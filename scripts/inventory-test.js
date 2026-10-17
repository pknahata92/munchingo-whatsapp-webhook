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
  // items
  const nr = await inv.addItem({ name: 'Bubble wrap', kind: 'packaging', unit: 'rolls', lowLevel: 2 }); ok(nr.slug === 'bubble-wrap', 'owner can add an item');
  await rejects(inv.addItem({ name: 'Bubble wrap', kind: 'packaging' }), /already/, 'no duplicate item');
  console.log(`inventory-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
