'use strict';
// Lot codes, IST dates, cut-offs, eligibility, landed cost.   node scripts/lots-test.js
const L = require('../utils/lots');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ')');
const D = L.DEFAULTS;

// settings
eq(L.DEFAULTS, { shelf_days: 90, ship_floor_days: 50, dispatch_days: 2, old_bake_days: 7, sticker_flags: '--cols 3 --col-gap 0.7 --left 4.0 --small-mrp --pitch 17.84375 --head-shift 2 --test', lots_from: null, packaging_count_from: null }, 'defaults');
eq(L.readSettings({}), D, 'empty raw gives defaults');
const rs = L.readSettings({ packaging_count_from: '2026-11-08 15:10:00+00', shelf_days: '60', ship_floor_days: 'abc', dispatch_days: '-1', old_bake_days: '3.5', sticker_flags: '--x', lots_from: '2026-11-08T00:00:00Z' });
eq([rs.shelf_days, rs.ship_floor_days, rs.dispatch_days, rs.old_bake_days, rs.sticker_flags, rs.lots_from], [60, 50, 2, 7, '--x', '2026-11-08T00:00:00Z'], 'readSettings parses and falls back');
eq([rs.packaging_count_from, L.readSettings({}).packaging_count_from], ['2026-11-08 15:10:00+00', null], 'packaging_count_from is read as text, null when absent');
eq(L.LETTERS, { 'atta-original': 'O', 'atta-kesari': 'K', 'atta-ajwain': 'A', 'atta-lite-sugar': 'L' }, 'letters');
eq(L.SLUG_OF_LETTER.K, 'atta-kesari', 'slug of letter');

// dates
eq(L.datesFor('2026-11-05', D), { bestBefore: '2027-02-03', lastShip: '2026-12-15', websiteStop: '2026-12-13' }, 'datesFor');
eq(L.cutoffs('2027-01-13', D), { lastShip: '2026-11-24', websiteStop: '2026-11-22' }, 'cutoffs 13 Jan');
eq(L.cutoffs('2027-01-25', D), { lastShip: '2026-12-06', websiteStop: '2026-12-04' }, 'cutoffs 25 Jan');
eq(L.cutoffs(null, D), null, 'cutoffs null');
ok(L.addDays('2026-12-31', 1) === '2027-01-01', 'year end');
ok(L.addDays('2028-02-28', 1) === '2028-02-29', 'leap');
ok(L.addDays('2026-11-05', -5) === '2026-10-31', 'negative');
ok(L.datesFor('2027-11-30', D).bestBefore === '2028-02-28', 'bb across leap year');
ok(L.todayIst(Date.parse('2026-11-21T18:29:00Z')) === '2026-11-21', 'IST before midnight');
ok(L.todayIst(Date.parse('2026-11-21T18:31:00Z')) === '2026-11-22', 'IST after midnight');

// eligibility
const lot = (status, bb) => ({ status, best_before: bb });
const BB = '2027-01-13';
ok(L.eligible(lot('released', BB), 'web', '2026-11-21', D) === true, 'web last day');
ok(L.eligible(lot('released', BB), 'web', '2026-11-22', D) === false, 'web stop day');
ok(L.eligible(lot('released', BB), 'pack', '2026-11-24', D) === true, 'pack last ship');
ok(L.eligible(lot('released', BB), 'pack', '2026-11-25', D) === false, 'pack after');
ok(L.eligible(lot('released', BB), 'other', '2027-01-13', D) === true, 'other bb day');
ok(L.eligible(lot('released', BB), 'other', '2027-01-14', D) === false, 'other after bb');
ok(L.eligible(lot(null, BB), 'web', '2026-11-21', D) === true, 'legacy dated eligible');
ok(L.eligible(lot(null, BB), 'web', '2026-11-22', D) === false, 'legacy dated cut off');
for (const st of ['hold', 'rejected', 'void']) for (const p of ['web', 'pack', 'other']) {
  ok(L.eligible(lot(st, BB), p, '2026-11-01', D) === false, st + ' never ' + p);
  ok(L.eligible(lot(st, null), p, '2026-11-01', D) === false, st + ' undated never ' + p);
}
for (const p of ['web', 'pack', 'other']) {
  ok(L.eligible(lot(null, null), p, '2030-01-01', D) === true, 'legacy undated ' + p);
  ok(L.eligible(lot('released', null), p, '2030-01-01', D) === true, 'released undated ' + p);
}

// codes
ok(L.lotCode('atta-kesari', '2026-11-05', 1) === 'MNGK-261105-01', 'lotCode');
ok(L.lotCode('atta-kesari', '2026-11-05', 1).length === 14, 'code is 14 chars');
ok(L.lotCode('atta-lite-sugar', '2026-11-05', 12) === 'MNGL-261105-12', 'seq 12');
let threw = 0; for (const s of [0, 100, 1.5, '1']) { try { L.lotCode('atta-kesari', '2026-11-05', s); } catch (e) { if (e instanceof Error) threw++; } }
ok(threw === 4, 'bad seq throws');
eq(L.parseCode('MNGK-261105-01'), { slug: 'atta-kesari', bakeDate: '2026-11-05', seq: 1 }, 'parseCode');
ok(L.parseCode('15OCT26') === null, 'old code not parsed');
ok(L.parseCode('MNGK-261131-01') === null, 'impossible date');
ok(L.parseCode('MNGX-261105-01') === null, 'bad letter');
ok(L.parseCode('MNGK-261105-1') === null, 'short seq');
ok(L.parseCode(null) === null, 'null code');
ok(L.nextSeq(['MNGK-261105-01', 'MNGK-261105-02', 'MNGO-261105-01'], 'atta-kesari', '2026-11-05') === 3, 'nextSeq');
ok(L.nextSeq(['MNGK-261105-01', 'MNGK-261105-05', '15OCT26'], 'atta-kesari', '2026-11-05') === 6, 'nextSeq uses highest, ignores junk');
ok(L.nextSeq([], 'atta-kesari', '2026-11-05') === 1, 'nextSeq empty');
ok(L.nextSeq(['MNGK-261104-03'], 'atta-kesari', '2026-11-05') === 1, 'nextSeq other date');

// landed cost
const fr = { bus_per_carton: 150, delhi_per_carton: 50, porter: 300, other: 0 };
const lc = L.landedCost({ cartons: 10, freight: fr, lots: [{ key: 'o', invoiceBoxes: 100, rateRupees: 85, good: 98 }, { key: 'k', invoiceBoxes: 100, rateRupees: 100, good: 100 }] });
eq(lc, { o: { landedPaise: 965000, perGoodPaise: 9847 }, k: { landedPaise: 1115000, perGoodPaise: 11150 } }, 'landed cost two lots');
const lz = L.landedCost({ cartons: 10, freight: fr, lots: [{ key: 'z', invoiceBoxes: 100, rateRupees: 85, good: 0 }] });
ok(lz.z.perGoodPaise === null && lz.z.landedPaise === 8500 * 100 + 230000, 'good 0 gives null per good');
const l0 = L.landedCost({ cartons: 0, freight: fr, lots: [{ key: 'a', invoiceBoxes: 0, rateRupees: 85, good: 5 }] });
ok(l0.a.landedPaise === 0 && l0.a.perGoodPaise === 0, 'zero invoice boxes: no freight share');

// sticker
ok(L.stickerCommand('MNGK-261105-01', 106, '--cols 3') === 'python3 make_stamp_labels.py --lot MNGK-261105-01 --qty kesari=106 --cols 3', 'sticker command');
ok(L.stickerCommand('MNGL-261105-01', 4, '') === 'python3 make_stamp_labels.py --lot MNGL-261105-01 --qty lite=4', 'sticker no flags, no trailing space');
ok(L.stickerCommand('MNGO-261105-01', 1, null) === 'python3 make_stamp_labels.py --lot MNGO-261105-01 --qty original=1', 'sticker null flags');

// Final review C1/C2: which lot a typed code reaches, one per flavour: (a) exact own code, (b) own code ignoring case, (c) an alias.
// An alias that another row of the same flavour owns as its own code belongs to that row, never to the lot that lists it.
{
  const rows = [
    { item_slug: 'atta-lite-sugar', lot_code: '15Oct26', status: 'released', aliases: [] },
    { item_slug: 'atta-lite-sugar', lot_code: '15OCT26', status: 'released', aliases: ['MNGL-261016-01'] },
    { item_slug: 'atta-kesari', lot_code: '15OCT26', status: 'released', aliases: ['MNGK-261016-01'] },
    { item_slug: 'atta-original', lot_code: '27OCT26', status: 'released', aliases: ['MNGO-261027-01'] },   // the old backfill: an alias that is also its own lot
    { item_slug: 'atta-original', lot_code: 'MNGO-261027-01', status: 'hold', aliases: [] },
  ];
  const ledger = [{ item_slug: 'atta-lite-sugar', lot_code: '15OCT26', qty: 20 }, { item_slug: 'atta-lite-sugar', lot_code: '15Oct26', qty: 0 }, { item_slug: 'atta-ajwain', lot_code: 'OLD1', qty: 4 }, { item_slug: 'atta-ajwain', lot_code: 'old1', qty: 0 }];
  const r = (code, slug) => L.resolveCode(rows, ledger, code, slug).map((x) => [x.slug, x.code, x.how]);
  eq(r('15OCT26', 'atta-lite-sugar'), [['atta-lite-sugar', '15OCT26', 'exact']], 'exact own code wins over the case variant');
  eq(r('15Oct26', 'atta-lite-sugar'), [['atta-lite-sugar', '15Oct26', 'exact']], 'the other spelling opens its own lot');
  eq(r('15oct26', 'atta-lite-sugar'), [['atta-lite-sugar', '15OCT26', 'case']], 'no exact match: one lot ignoring case (the upper-case code first)');
  eq(r('mngl-261016-01'), [['atta-lite-sugar', '15OCT26', 'alias']], 'an alias, any case, opens the lot that has it');
  eq(r('15OCT26'), [['atta-kesari', '15OCT26', 'exact'], ['atta-lite-sugar', '15OCT26', 'exact']], 'a shared code: one entry per flavour, never two for one flavour');
  eq(r('MNGO-261027-01', 'atta-original'), [['atta-original', 'MNGO-261027-01', 'exact']], 'an alias that is another lot\'s own code is that lot');
  eq(r('27OCT26', 'atta-original'), [['atta-original', '27OCT26', 'exact']], 'and the old code opens its own lot');
  eq(r('OLD1', 'atta-ajwain'), [['atta-ajwain', 'OLD1', 'exact']], 'a ledger-only code is a legacy lot');
  eq(r('Old1', 'atta-ajwain'), [['atta-ajwain', 'OLD1', 'case']], 'two ledger-only spellings: one lot, the upper-case one first');
  eq(r('NOPE'), [], 'nothing found');
  // after Fix lot 15OCT26 -> MNGL-261016-01 the old code is an alias, and the empty lot spelt 15Oct26 is still an own code
  const fixed = [{ item_slug: 'atta-lite-sugar', lot_code: '15Oct26', status: 'released', aliases: [] }, { item_slug: 'atta-lite-sugar', lot_code: 'MNGL-261016-01', status: 'hold', aliases: ['15OCT26'] }];
  const fl = [{ item_slug: 'atta-lite-sugar', lot_code: '15Oct26', qty: 0 }, { item_slug: 'atta-lite-sugar', lot_code: 'MNGL-261016-01', qty: 18 }, { item_slug: 'atta-lite-sugar', lot_code: '15OCT26', qty: 1 }];
  eq(['15OCT26', '15oct26', '15Oct26'].map((x) => L.resolveCode(fixed, fl, x, 'atta-lite-sugar').map((y) => y.code + ':' + y.how).join()), ['MNGL-261016-01:alias', 'MNGL-261016-01:alias', '15Oct26:exact'], 'the old code (any case) reaches the fixed lot; only the exact other spelling opens the empty lot');
  // the shape the backfill makes now (rename fold): the emptied spelling is an alias of the lot it was renamed to
  const foldRows = [{ item_slug: 'atta-lite-sugar', lot_code: '15OCT26', status: 'released', aliases: ['MNGL-261016-01', '15Oct26'] }];
  eq(['15Oct26', '15OCT26', '15oct26', 'MNGL-261016-01'].map((x) => L.resolveCode(foldRows, [], x, 'atta-lite-sugar').map((y) => y.code + ':' + y.how).join()), ['15OCT26:alias', '15OCT26:exact', '15OCT26:case', '15OCT26:alias'], 'fold shape: every spelling of lot 1 reaches the one lot');
  const idx = L.lotIndex(rows);
  eq(L.codesOfLot(idx, rows[3]), ['27OCT26'], 'a lot\'s codes leave out an alias another lot owns');
  eq(L.codesOfLot(idx, rows[1]), ['15OCT26', 'MNGL-261016-01'], 'a lot\'s codes: its own and its aliases');
  eq(idx.get('atta-kesari|MNGK-261016-01').lot_code, '15OCT26', 'the index maps an alias to its lot');
  eq(idx.get('atta-original|MNGO-261027-01').lot_code, 'MNGO-261027-01', 'the index maps an owned code to the lot that owns it');
  // Final review I2: a lot the owner put on hold after it was released (or after the backfill made it released) is the owner's
  eq([{ status: 'hold' }, { status: 'hold', hold_reason: 'recall' }, { status: 'hold', released_at: '2026-11-01T00:00:00Z' }, { status: 'released', hold_reason: 'old' }].map(L.ownerHold), [false, true, true, false], 'ownerHold: a hold with a reason or after a release');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
