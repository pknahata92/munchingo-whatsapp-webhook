'use strict';
// Lot codes, IST dates, cut-offs, eligibility, landed cost.   node scripts/lots-test.js
const L = require('../utils/lots');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ')');
const D = L.DEFAULTS;

// settings
eq(L.DEFAULTS, { shelf_days: 90, ship_floor_days: 50, dispatch_days: 2, old_bake_days: 7, sticker_flags: '--cols 3 --col-gap 0.7 --left 4.0 --small-mrp --pitch 18 --head-shift -54 --test', lots_from: null }, 'defaults');
eq(L.readSettings({}), D, 'empty raw gives defaults');
const rs = L.readSettings({ shelf_days: '60', ship_floor_days: 'abc', dispatch_days: '-1', old_bake_days: '3.5', sticker_flags: '--x', lots_from: '2026-11-08T00:00:00Z' });
eq([rs.shelf_days, rs.ship_floor_days, rs.dispatch_days, rs.old_bake_days, rs.sticker_flags, rs.lots_from], [60, 50, 2, 7, '--x', '2026-11-08T00:00:00Z'], 'readSettings parses and falls back');
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

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
