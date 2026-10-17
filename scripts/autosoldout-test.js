'use strict';
// Automatic sold-out: sellable = on the shelf - paid but unpacked; paused by hand; cart quantity check.   node scripts/autosoldout-test.js
const path = require('path'); const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const { memStore } = require('./inventory-memstore');
const inv = require(path.join(root, 'utils/inventory.js'));
const A = { email: 'x@y.z', name: 'X' };
(async () => {
  const st = memStore('2026-10-01T00:00:00.000Z'); const real = inv.makeInventory(st);
  // pure functions
  const items = [{ slug: 'atta-kesari', kind: 'product', active: true }, { slug: 'atta-ajwain', kind: 'product', active: true }, { slug: 'tape', kind: 'packaging', active: true }];
  const sm = inv.computeSellable(items, [{ item_slug: 'atta-kesari', qty: 30 }, { item_slug: 'tape', qty: 5 }], { 'atta-kesari': 28 });
  ok(sm['atta-kesari'] === 2 && !('atta-ajwain' in sm) && !('tape' in sm), 'sellable = shelf minus paid-but-unpacked; uncounted flavours and packaging are left out');
  ok(inv.computeSellable(items, [{ item_slug: 'atta-kesari', qty: 10 }], { 'atta-kesari': 12 })['atta-kesari'] === -2, 'oversold shows below zero');
  const sellOf = (m) => (slug) => (slug in m ? m[slug] : null);
  ok(inv.firstShortage([{ slug: 'atta-kesari', qty: 3 }], sellOf({ 'atta-kesari': 2 })).have === 2, 'cart asking for 3 with 2 left is refused');
  ok(inv.firstShortage([{ slug: 'atta-kesari', qty: 2 }], sellOf({ 'atta-kesari': 2 })) === null, 'cart asking for exactly what is left passes');
  ok(inv.firstShortage([{ slug: 'trio-gift-set-kesari-lite-sugar-original', qty: 1 }], sellOf({ 'atta-lite-sugar': 0 })).slug === 'atta-lite-sugar', 'a gift set is limited by its scarcest flavour');
  ok(inv.firstShortage([{ slug: 'full-range-set', qty: 2 }, { slug: 'atta-ajwain', qty: 1 }], sellOf({ 'atta-ajwain': 2 })).boxes === 3, 'a set and a single of the same flavour are added together');
  ok(inv.firstShortage([{ slug: 'atta-kesari', qty: 40 }], sellOf({})) === null, 'a flavour with no stock recorded is never limited');
  // test orders from before launch must not hold back real stock
  const rowsC = [
    { created_at: '2026-09-23T10:00:00+05:30', items: [{ slug: 'atta-ajwain', quantity: 1 }] },                 // FX82-2309: a pre-launch test order, paid, not packed
    { created_at: '2026-10-11T09:00:00+05:30', items: [{ slug: 'full-range-set', quantity: 1 }] },              // a real pre-order
    { created_at: '2026-10-17T14:48:00+05:30', items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }] },
  ];
  const cm = inv.committedBoxes(rowsC);
  ok(cm['atta-ajwain'] === 1 && cm['atta-lite-sugar'] === 2 && cm['atta-kesari'] === 2, 'the 23 Sep test order is not counted as committed; real orders from launch week are');
  ok(inv.committedBoxes(rowsC, '2026-09-01T00:00:00+05:30')['atta-ajwain'] === 2, 'the cut-off can be moved (stock_settings.orders_from)');
  // overview carries the numbers the screen needs
  await real.receive({ slug: 'atta-kesari', received: 30, lot: 'L1', actor: A });
  st.committedMap = { 'atta-kesari': 28 }; st.pausedList = ['atta-ajwain'];
  let ov = await real.overview(); let k = ov.items.find((i) => i.slug === 'atta-kesari'); let aj = ov.items.find((i) => i.slug === 'atta-ajwain');
  ok(k.on_hand === 30 && k.committed === 28 && k.sellable === 2 && !k.paused, 'inventory shows shelf, committed and sellable');
  ok(aj.paused === true && aj.sellable === null, 'a paused flavour is flagged; an uncounted one has no sellable number');
  // the stock module: manual pause + automatic, with the ledger and the database stubbed
  const stockPath = require.resolve(path.join(root, 'utils/stock.js'));
  let rows = [{ slug: 'atta-ajwain', available: false }];
  require.cache[require.resolve(path.join(root, 'utils/database.js'))] = { id: 'db', filename: 'db', loaded: true, exports: { listStock: async () => rows, setStock: async () => {} } };
  require.cache[require.resolve(path.join(root, 'utils/prices.js'))] = { id: 'pr', filename: 'pr', loaded: true, exports: { ensureFresh: async () => {} } };
  inv.instance = () => real;
  delete require.cache[stockPath]; const stock = require(stockPath);
  await stock.refresh();
  ok(stock.pausedSlugs().join() === 'atta-ajwain' && stock.sellable('atta-kesari') === 2 && stock.autoSoldOutSlugs().length === 0, 'paused list and sellable numbers load');
  ok(stock.soldOutSlugs().join() === 'atta-ajwain', 'only the paused flavour is sold out while stock remains');
  st.committedMap = { 'atta-kesari': 30 }; await stock.refresh();
  ok(stock.autoSoldOutSlugs().join() === 'atta-kesari' && stock.soldOutSlugs().sort().join() === 'atta-ajwain,atta-kesari', 'at zero sellable the flavour is sold out automatically, on top of the paused one');
  const catalog = require(path.join(root, 'utils/catalog.js'));
  ok(!catalog.isAvailable('atta-kesari') && !catalog.isAvailable('trio-gift-set-kesari-lite-sugar-original') && !catalog.isAvailable('full-range-set') && catalog.isAvailable('atta-original'), 'the shop treats it as sold out, including gift sets that contain it');
  st.committedMap = {}; await stock.refresh(); ok(stock.autoSoldOutSlugs().length === 0 && catalog.isAvailable('atta-kesari'), 'it comes back by itself when stock is received or an order is cancelled');
  rows = []; await stock.refresh(); ok(stock.soldOutSlugs().length === 0, 'resuming a paused flavour works');
  // failure keeps the last known answer and never blocks the shop
  st.committedMap = { 'atta-kesari': 30 }; await stock.refresh(); const before = stock.autoSoldOutSlugs().join();
  inv.instance = () => ({ sellable: async () => { throw new Error('db down'); } }); await stock.refresh();
  ok(stock.autoSoldOutSlugs().join() === before && before === 'atta-kesari', 'if the ledger cannot be read the last known sold-out list is kept');
  inv.instance = () => ({ sellable: async () => { throw new Error('Run stock_ledger_migration.sql in Supabase first.'); } }); const o = console.error; let logged = false; console.error = () => { logged = true; }; await stock.refresh(); console.error = o;
  ok(!logged, 'a not-yet-migrated database stays quiet');
  console.log(`autosoldout-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
