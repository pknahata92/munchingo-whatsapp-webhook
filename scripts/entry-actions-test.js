'use strict';
// Whole-entry Reverse and Relabel against the in-memory ledger.   node scripts/entry-actions-test.js
const { makeInventory: makeInv, StockError } = require('../utils/inventory');
const NOW = Date.parse('2026-10-31T06:00:00Z');
const makeInventory = (store, opts) => makeInv(store, { now: () => NOW, ...(opts || {}) });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const rejects = async (p, re, m) => { try { await p; ok(false, m + ' (did not throw)'); } catch (e) { ok(e instanceof StockError && re.test(e.message), m + ' (got: ' + e.message + ')'); } };
const { memStore } = require('./inventory-memstore');
const A = { email: 'staff@x.com', name: 'Staff' };
const SLUGS = ['atta-original', 'atta-ajwain', 'atta-kesari', 'atta-lite-sugar'];
const onHand = async (inv, slug) => (await inv.overview()).items.find((i) => i.slug === slug).on_hand;

(async () => {
  const st = memStore('2026-10-16T00:00:00.000Z'); const inv = makeInventory(st);
  for (const s of SLUGS) await inv.receive({ slug: s, received: 100, lot: '15OCT26', bestBefore: '2027-01-13', actor: A });
  const sold = async (who) => { const b = {}; SLUGS.forEach((s) => { b[s] = 8; }); return inv.offlineHamper({ hamper: 'Diwali', hampers: 8, boxes: b, buyer: who, invoice: 'PENDING', actor: A }); };
  const live = (type) => st.mv.filter((m) => m.type === type && !st.mv.some((r) => r.reverses_id === m.id));
  const before = async () => Promise.all(SLUGS.map((s) => onHand(inv, s)));

  // ── reverse a whole entry ──
  await sold('Barkha');
  const ids = live('OFFLINE_SALE').map((m) => m.id);
  ok(ids.length === 4 && (await before()).every((n) => n === 92), 'setup: a 4-line hamper sale took 8 of each Flavor');
  await rejects(inv.reverseEntry({ ids, reason: '', actor: A }), /reason/, 'a whole-entry reverse needs a reason');
  await rejects(inv.reverseEntry({ ids: [], reason: 'x', actor: A }), /No lines/, 'no lines is refused');
  const n0 = st.mv.length;
  await rejects(inv.reverseEntry({ ids: [...ids, 99999], reason: 'x', actor: A }), /No such line/, 'one unknown id refuses everything');
  ok(st.mv.length === n0, 'and writes nothing (all or nothing)');
  const r = await inv.reverseEntry({ ids: [ids[0], ids[0], ...ids.slice(1)], reason: 'wrong buyer', actor: A });
  ok(r.ok && r.reversed === 4, 'a duplicate id is counted once; four lines reversed');
  ok((await before()).every((n) => n === 100), 'stock is back to 100 of each');
  const rv = st.mv.filter((m) => m.type === 'REVERSAL');
  ok(rv.length === 4 && new Set(rv.map((m) => m.created_at)).size === 1 && rv.every((m) => m.note === 'wrong buyer' && m.actor_name === 'Staff'), 'four reversals saved together (one time), each with the reason and the person');
  await rejects(inv.reverseEntry({ ids, reason: 'again', actor: A }), /already reversed/, 'an entry cannot be reversed twice');

  // a part-reversed entry: reverse the rest only
  await sold('Dhruv');
  const ids2 = live('OFFLINE_SALE').map((m) => m.id);
  await inv.reverse({ id: ids2[0], reason: 'one line only', actor: A });
  await rejects(inv.reverseEntry({ ids: ids2, reason: 'rest', actor: A }), /already reversed/, 'asking for a line that is already reversed is refused');
  const r2 = await inv.reverseEntry({ ids: ids2.slice(1), reason: 'rest', actor: A });
  ok(r2.reversed === 3 && (await before()).every((n) => n === 100), 'the remaining three lines can be reversed');

  // staff cannot reverse an old entry, the owner can
  await sold('Old');
  const idsOld = live('OFFLINE_SALE').map((m) => m.id);
  st.mv.filter((m) => idsOld.includes(m.id)).forEach((m) => { m.created_at = new Date(NOW - 30 * 3600_000).toISOString(); });
  await rejects(inv.reverseEntry({ ids: idsOld, reason: 'x', actor: A, isOwner: false }), /owner/, 'staff cannot reverse an entry older than a day');
  ok((await inv.reverseEntry({ ids: idsOld, reason: 'x', actor: A, isOwner: true })).reversed === 4, 'the owner can');

  // sales, reversals and delivery lines are not reversible as an entry either
  const sale = { item_slug: 'atta-original', qty: -1, type: 'SALE', lot_code: '15OCT26' };
  await st.insert([sale]); const saleId = st.mv[st.mv.length - 1].id;
  await rejects(inv.reverseEntry({ ids: [saleId], reason: 'x', actor: A, isOwner: true }), /Undo on the order/, 'a website sale is handled by its order');
  await rejects(inv.reverseEntry({ ids: [rv[0].id], reason: 'x', actor: A, isOwner: true }), /reversal cannot be reversed/, 'a reversal cannot be reversed');

  // ── relabel an entry ──
  // The Sarthak case: boxes logged as a gift, later billed. Stock must not move; the history shows the cancelled gift and the new sale.
  const g = {}; SLUGS.forEach((s) => { g[s] = 2; });
  await inv.takeMany({ boxes: g, type: 'GIFT', who: 'Sarthak', actor: A });
  const gid = live('GIFT').map((m) => m.id);
  const h0 = await before();
  await rejects(inv.relabelEntry({ ids: gid, type: 'OFFLINE_SALE', who: 'Barkha', invoice: '', reason: 'billed', actor: A }), /invoice/, 'a sale needs an invoice number (or PENDING)');
  await rejects(inv.relabelEntry({ ids: gid, type: 'OFFLINE_SALE', who: '', invoice: 'PENDING', reason: 'billed', actor: A }), /who bought/i, 'a sale needs a buyer');
  await rejects(inv.relabelEntry({ ids: gid, type: 'OFFLINE_SALE', who: 'Barkha', invoice: 'PENDING', reason: '', actor: A }), /reason/, 'a relabel needs a reason');
  await rejects(inv.relabelEntry({ ids: gid, type: 'SALE', who: 'x', reason: 'r', actor: A }), /Choose what/, 'only the take-out types can be chosen');
  const n1 = st.mv.length;
  const rl = await inv.relabelEntry({ ids: gid, type: 'OFFLINE_SALE', who: 'Barkha', invoice: 'PENDING', reason: 'it was billed after all', actor: A });
  ok(rl.ok && rl.lines === 4, 'relabelled four lines');
  ok(JSON.stringify(await before()) === JSON.stringify(h0), 'stock did not move');
  const added = st.mv.slice(n1);
  ok(added.length === 8 && new Set(added.map((m) => m.created_at)).size === 1, 'four reversals and four new lines, saved in one go');
  const nl = added.filter((m) => m.type === 'OFFLINE_SALE');
  ok(nl.length === 4 && nl.every((m) => m.party === 'Barkha' && m.ref === 'PENDING' && m.qty === -2 && m.lot_code === '15OCT26' && m.best_before === '2027-01-13' && m.actor_name === 'Staff'), 'new lines: new buyer and invoice, same boxes, same lot and best before');
  ok(added.filter((m) => m.type === 'REVERSAL').length === 4 && gid.every((id) => st.mv.some((m) => m.reverses_id === id)), 'every old gift line is cancelled with its own reversal');
  ok(st.mv.filter((m) => gid.includes(m.id)).every((m) => m.type === 'GIFT' && m.ref === 'Sarthak'), 'the old lines are untouched (nothing is edited)');
  ok(added.filter((m) => m.type === 'REVERSAL').every((m) => /it was billed after all/.test(m.note)), 'the reason is on the reversals');
  await rejects(inv.relabelEntry({ ids: gid, type: 'GIFT', who: 'Sarthak', reason: 'again', actor: A }), /already reversed/, 'an already relabelled entry cannot be relabelled from its old lines');

  // note is kept unless a new one is given; a gift keeps the name in ref and no party
  const nb = {}; nb['atta-kesari'] = 3;
  await inv.takeMany({ boxes: nb, type: 'GIFT', who: 'Ravi', note: 'Diwali', actor: A });
  const gi = live('GIFT').map((m) => m.id);
  await inv.relabelEntry({ ids: gi, type: 'GIFT', who: 'Ravi Kumar', reason: 'full name', actor: A });
  const ng = st.mv.filter((m) => m.type === 'GIFT' && m.ref === 'Ravi Kumar');
  ok(ng.length === 1 && ng[0].note === 'Diwali' && !ng[0].party, 'a gift keeps its note, the name goes in the reference, and there is no buyer');
  await inv.relabelEntry({ ids: ng.map((m) => m.id), type: 'GIFT', who: 'Ravi Kumar', note: 'Wedding', reason: 'note', actor: A });
  ok(st.mv.some((m) => m.type === 'GIFT' && m.ref === 'Ravi Kumar' && m.note === 'Wedding' && !st.mv.some((r) => r.reverses_id === m.id)), 'a new note replaces the old one');

  // lines that cannot be relabelled
  const rcv = st.mv.find((m) => m.type === 'RECEIVE');
  await rejects(inv.relabelEntry({ ids: [rcv.id], type: 'GIFT', who: 'x', reason: 'r', actor: A, isOwner: true }), /taken out/i, 'a receipt cannot be relabelled');
  const old = live('OFFLINE_SALE').map((m) => m.id);
  st.mv.filter((m) => old.includes(m.id)).forEach((m) => { m.created_at = new Date(NOW - 30 * 3600_000).toISOString(); });
  await rejects(inv.relabelEntry({ ids: old, type: 'OFFLINE_SALE', who: 'Z', invoice: 'PENDING', reason: 'r', actor: A, isOwner: false }), /owner/, 'staff cannot relabel an entry older than a day');
  ok((await inv.relabelEntry({ ids: old, type: 'OFFLINE_SALE', who: 'Z', invoice: 'INV-1', reason: 'r', actor: A, isOwner: true })).lines === old.length, 'the owner can');

  // ── independent review, 16 Nov 2026 ──
  const addRow = async (o) => { await st.insert([{ item_slug: 'atta-original', lot_code: '15OCT26', best_before: '2027-01-13', ...o }]); return st.mv[st.mv.length - 1].id; };
  // event lines are netted by the event return, not by reversals: refuse them here
  const ex = await addRow({ type: 'EXHIBITION', qty: -3, ref: 'Diwali Mela' });
  await rejects(inv.reverseEntry({ ids: [ex], reason: 'x', actor: A, isOwner: true }), /event/i, 'an event line cannot be reversed as an entry');
  await rejects(inv.relabelEntry({ ids: [ex], type: 'GIFT', who: 'x', reason: 'x', actor: A, isOwner: true }), /event/i, 'an event line cannot be relabelled');
  // only the kinds History offers can be reversed by hand: rejected-lot and expired lines belong to the delivery flow
  for (const type of ['SUPPLIER_RETURN', 'EXPIRED']) {
    const id1 = await addRow({ type, qty: -2, note: 'x' });
    await rejects(inv.reverseEntry({ ids: [id1], reason: 'x', actor: A, isOwner: true }), /cannot be reversed here/, type + ' cannot be reversed as an entry');
    await rejects(inv.reverse({ id: id1, reason: 'x', actor: A, isOwner: true }), /cannot be reversed here/, type + ' cannot be reversed as a single line either');
  }
  // the damage reason travels with the line
  const dm = await addRow({ type: 'DAMAGED', qty: -1, note: 'crushed', reason: 'transit' });
  await inv.relabelEntry({ ids: [dm], type: 'DAMAGED', who: '', note: 'crushed in the van', reason: 'fix note', actor: A });
  ok(st.mv.some((m) => m.type === 'DAMAGED' && m.note === 'crushed in the van' && m.reason === 'transit'), 'a relabelled damaged line keeps its damage reason');
  ok(st.mv.some((m) => m.type === 'REVERSAL' && m.reverses_id === dm && m.reason === 'transit'), 'and so does its reversal');
  // bad kinds and bad ids give plain errors
  for (const bad of ['constructor', 'toString', '__proto__']) await rejects(inv.relabelEntry({ ids: [dm], type: bad, who: '', reason: 'x', actor: A }), /Choose what happened/, 'kind "' + bad + '" is refused in plain words');
  for (const bad of [[true], [[2]], ['1e30'], [1e30], ['abc'], [-1], [1.5]]) await rejects(inv.reverseEntry({ ids: bad, reason: 'x', actor: A, isOwner: true }), /No such line|No lines|whole numbers/, 'id ' + JSON.stringify(bad) + ' is refused');

  console.log(`entry-actions-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
