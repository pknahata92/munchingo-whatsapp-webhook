'use strict';
// In-memory stand-in for the stock tables (tests and the practice admin). Mirrors the database's one-write-per-sale rule
// and its list of allowed movement types (stock_movements_type_check; kept equal to the latest migration by inventory-test).
// Also mirrors the batch-receiving tables (stock_lots, stock_deliveries) and the all-or-nothing stock_save_delivery function.
const TYPES = new Set(['RECEIVE', 'DAMAGED', 'SALE', 'SALE_UNDO', 'USE', 'SAMPLE', 'GIFT', 'EXHIBITION', 'EXHIBITION_RETURN', 'OFFLINE_SALE', 'EVENT_SALE', 'RETURN', 'COUNT_FIX', 'REVERSAL', 'SUPPLIER_RETURN', 'EXPIRED', 'REPLACEMENT']);
function memStore(trackingFrom) {
  let id = 0; const mv = [];
  const items = [
    { slug: 'atta-kesari', name: 'Atta Kesari', kind: 'product', unit: 'boxes', low_level: 30, manual_low: false, active: true, sort: 10 },
    { slug: 'atta-original', name: 'Atta Original', kind: 'product', unit: 'boxes', low_level: 30, manual_low: false, active: true, sort: 11 },
    { slug: 'atta-ajwain', name: 'Atta Ajwain', kind: 'product', unit: 'boxes', low_level: 30, manual_low: false, active: true, sort: 12 },
    { slug: 'atta-lite-sugar', name: 'Atta Sugar-Lite', kind: 'product', unit: 'boxes', low_level: 30, manual_low: false, active: true, sort: 13 },
    { slug: 'mono-original', name: 'Mono carton: Original', kind: 'packaging', unit: 'cartons', low_level: 0, manual_low: false, active: true, sort: 20 },
    { slug: 'mono-kesari', name: 'Mono carton: Kesari', kind: 'packaging', unit: 'cartons', low_level: 0, manual_low: false, active: true, sort: 21 },
    { slug: 'mono-ajwain', name: 'Mono carton: Ajwain', kind: 'packaging', unit: 'cartons', low_level: 0, manual_low: false, active: true, sort: 22 },
    { slug: 'mono-lite-sugar', name: 'Mono carton: Sugar-Lite', kind: 'packaging', unit: 'cartons', low_level: 0, manual_low: false, active: true, sort: 23 },
    { slug: 'label-stamp', name: 'Stamp / batch labels', kind: 'packaging', unit: 'labels', low_level: 0, manual_low: false, active: true, sort: 41 },
    { slug: 'packing-tape', name: 'Packing tape', kind: 'packaging', unit: 'rolls', low_level: 0, manual_low: false, active: true, sort: 33 },
  ];
  // defaults equal batch_receiving_migration.sql (inventory-test checks it)
  const settings = { tracking_from: trackingFrom, shelf_days: '90', ship_floor_days: '50', dispatch_days: '2', old_bake_days: '7', sticker_flags: '--cols 3 --col-gap 0.7 --left 4.0 --small-mrp --pitch 17.84375 --head-shift 2 --test', lots_from: new Date().toISOString(), packaging_count_from: new Date().toISOString() };
  const lots = [], deliveries = [];
  const lotKey = (r) => r.item_slug + '|' + r.lot_code;
  const billKey = (d) => `${String(d.supplier).toLowerCase()}|${String(d.bill_no).toLowerCase()}|${d.part}`;
  const checkRows = (rows) => {
    rows.forEach((r) => {
      if (!TYPES.has(r.type)) throw new Error('new row for relation "stock_movements" violates check constraint "stock_movements_type_check" (' + r.type + ')');
      if (r.qty == null) throw new Error('null value in column "qty" of relation "stock_movements" violates not-null constraint');
      if (!Number.isInteger(r.qty) || r.qty === 0) throw new Error('new row for relation "stock_movements" violates check constraint "stock_movements_qty_check"');
      if (!items.some((i) => i.slug === r.item_slug)) throw new Error('insert or update on table "stock_movements" violates foreign key constraint "stock_movements_item_slug_fkey" (' + r.item_slug + ')');
    });
    // stock_movements_sale_once: one SALE (and one SALE_UNDO) per pack, flavour and lot, against the ledger AND within this one insert
    const seen = new Set(mv.filter((r) => r.type === 'SALE' || r.type === 'SALE_UNDO').map(uniq));
    rows.forEach((r) => { if (!(r.type === 'SALE' || r.type === 'SALE_UNDO')) return; if (seen.has(uniq(r))) throw new Error('duplicate key (sale written twice)'); seen.add(uniq(r)); });
  };
  const checkLots = (rows) => {
    const have = new Set(lots.map(lotKey));
    rows.forEach((r) => {
      if (!items.some((i) => i.slug === r.item_slug)) throw new Error('insert on table "stock_lots" violates foreign key constraint (' + r.item_slug + ')');
      if (!r.lot_code) throw new Error('null value in column "lot_code" of relation "stock_lots" violates not-null constraint');
      if (r.status && !['hold', 'released', 'rejected', 'void'].includes(r.status)) throw new Error('new row for relation "stock_lots" violates check constraint "stock_lots_status_check"');
      if (have.has(lotKey(r))) throw new Error('duplicate key value violates unique constraint "stock_lots_pkey"');
      have.add(lotKey(r));
    });
  };
  const lotRow = (r, deliveryId) => ({ delivery_id: deliveryId || null, supplier_batch: null, bake_date: null, best_before: null, status: 'hold', released_at: null, released_by: null, check_weight_g: null, check_note: null, reject_reason: null, hold_reason: null, unit_cost_paise: null, aliases: [], created_at: new Date().toISOString(), ...r, delivery_id: r.delivery_id ?? deliveryId ?? null, status: r.status ?? 'hold', aliases: r.aliases ?? [] });   // defaults after the spread, like the SQL coalesce
  const writeMoves = (rows) => rows.forEach((r) => mv.push({ id: ++id, created_at: new Date().toISOString(), reverses_id: null, ...r }));
  const uniq = (r) => `${r.ref}|${r.item_slug}|${r.lot_code || ''}|${r.type}`;
  return {
    mv,
    items: async () => items, item: async (s) => items.find((i) => i.slug === s) || null,
    byLot: async () => { const m = {}; mv.forEach((r) => { const k = `${r.item_slug}|${r.lot_code || ''}|${r.best_before || ''}`; (m[k] = m[k] || { item_slug: r.item_slug, lot_code: r.lot_code, best_before: r.best_before, qty: 0 }).qty += r.qty; }); return Object.values(m); },
    insert: async (rows) => { checkRows(rows); writeMoves(rows); },
    recent: async ({ item_slug, type, types, since, limit = 50 }) => mv.filter((r) => (!item_slug || r.item_slug === item_slug) && (!type || r.type === type) && (!types || !types.length || types.includes(r.type)) && (!since || r.created_at >= since)).slice().reverse().slice(0, limit),
    movement: async (i) => mv.find((r) => r.id === i) || null, reversalOf: async (i) => mv.some((r) => r.reverses_id === i), reversedAmong: async (ids) => mv.filter((r) => r.reverses_id && ids.includes(r.reverses_id)).map((r) => r.reverses_id),
    updateItem: async (s, f) => Object.assign(items.find((i) => i.slug === s), f), insertItem: async (row) => items.push({ manual_low: false, active: true, ...row }),
    setting: async (k) => settings[k] || null, settingsAll: async () => ({ ...settings }),
    setSetting: (k, v) => { settings[k] = v; },   // tests only (e.g. lots_from); the real store has no such call
    // batch receiving
    lots: async () => lots.slice(), lotsByCode: async (code) => lots.filter((l) => l.lot_code === code || (l.aliases || []).includes(code)),
    updateLot: async (slug, code, fields) => { const l = lots.find((x) => x.item_slug === slug && x.lot_code === code); if (l) Object.assign(l, fields); },   // fields may include lot_code (Fix lot): the row's key moves with it
    insertLots: async (rows) => { checkLots(rows); rows.forEach((r) => lots.push(lotRow(r, r.delivery_id))); },
    delivery: async (i) => deliveries.find((d) => d.id === i) || null,
    deliveriesByBill: async (supplier, billNo) => deliveries.filter((d) => String(d.supplier).toLowerCase() === String(supplier).toLowerCase() && String(d.bill_no).toLowerCase() === String(billNo).toLowerCase()),
    lastDelivery: async () => deliveries.filter((d) => d.status !== 'void').slice(-1)[0] || null,
    updateDelivery: async (i, fields) => { const d = deliveries.find((x) => x.id === i); if (d) Object.assign(d, fields); },
    // Packaging counts: for each slug that has at least one ledger row on or after `ts` (compared as times), the sum of those rows and the time of the newest.
    totalsSince: async (ts, slugs) => { const t0 = Date.parse(ts); const m = {}; mv.forEach((r) => { if (!slugs.includes(r.item_slug) || !(Date.parse(r.created_at) >= t0)) return; const e = m[r.item_slug] || (m[r.item_slug] = { item_slug: r.item_slug, qty: 0, last: r.created_at }); e.qty += r.qty; if (Date.parse(r.created_at) > Date.parse(e.last)) e.last = r.created_at; }); return Object.values(m); },
    movementsByLots: async (codes) => mv.filter((r) => r.lot_code && codes.includes(r.lot_code)),
    movementsByDelivery: async (i) => mv.filter((r) => r.delivery_id === i),
    // Mirrors stock_save_delivery: everything is checked first, so a throw writes nothing. The same receipt id again returns the first
    // result with again:true. Returns d, like the database function.
    saveDelivery: async ({ d, lots: lotsIn, moves: movesIn }) => {
      const newLots = lotsIn || [], moves = movesIn || [];
      if (!d || d.id == null || d.id === '') throw new Error('null value in column "id" of relation "stock_deliveries" violates not-null constraint');
      const first = deliveries.find((x) => x.id === d.id);
      if (first) return { ...(first.result || {}), again: true };
      if (!d.bill_no) throw new Error('null value in column "bill_no" of relation "stock_deliveries" violates not-null constraint');
      const row = { supplier: 'Krazy Bakers', part: 1, bilty: null, arrived_on: null, cartons: null, invoice_paise: null, gst_paise: null, billed_kg: null, freight: {}, photos: [], note: null, status: 'received', saved_by_email: null, saved_by_name: null, input: null, result: null, created_at: new Date().toISOString(), ...d };
      row.supplier = d.supplier ?? 'Krazy Bakers'; row.part = d.part ?? 1; row.status = d.status ?? 'received'; row.freight = d.freight ?? {}; row.photos = d.photos ?? [];   // like the SQL coalesce
      if (!['received', 'void'].includes(row.status)) throw new Error('new row for relation "stock_deliveries" violates check constraint "stock_deliveries_status_check"');
      if (row.status !== 'void' && deliveries.some((x) => x.status !== 'void' && billKey(x) === billKey(row))) throw new Error('duplicate key value violates unique constraint "stock_deliveries_bill_part_once"');
      checkLots(newLots);
      const moveRows = moves.map((m) => ({ ...m, delivery_id: m.delivery_id ?? d.id }));
      checkRows(moveRows);
      deliveries.push(row); newLots.forEach((l) => lots.push(lotRow(l, d.id))); writeMoves(moveRows);
      return d;
    },
    committedMap: {}, pausedList: [],
    committed: async function () { return this.committedMap; }, paused: async function () { return this.pausedList; },
    totals: async function () { const byId = Object.fromEntries(mv.map((r) => [r.id, r])); const t = {}; mv.forEach((r) => { const type = r.reverses_id && byId[r.reverses_id] ? byId[r.reverses_id].type : r.type; const k = r.item_slug + '|' + type; t[k] = (t[k] || 0) + r.qty; }); return Object.keys(t).map((k) => ({ item_slug: k.split('|')[0], type: k.split('|')[1], qty: t[k] })); },
    events: async () => { const m = {}; mv.filter((r) => r.type === 'EXHIBITION' || r.type === 'EXHIBITION_RETURN').forEach((r) => { const k = r.ref + '|' + r.item_slug; const e = m[k] || (m[k] = { ref: r.ref, item_slug: r.item_slug, taken: 0, returned: 0 }); if (r.type === 'EXHIBITION') e.taken += -r.qty; else e.returned += r.qty; }); return Object.values(m); },
    eventRows: async (ref, slug) => mv.filter((r) => r.ref === ref && r.item_slug === slug && (r.type === 'EXHIBITION' || r.type === 'EXHIBITION_RETURN')),
    salesOf: async (o) => mv.filter((r) => (r.type === 'SALE' || r.type === 'SALE_UNDO') && String(r.ref).startsWith(o + '@')),
    lotlessSales: async (since) => mv.filter((r) => (r.type === 'SALE' || r.type === 'SALE_UNDO') && r.lot_code == null && (!since || Date.parse(r.created_at) >= Date.parse(since))),
  };
}

// What batch_receiving_migration.sql step 7 (the backfill) makes on its first run, from the ledger rows (st.mv): one released lot per
// flavour and code, bake date from the code, the earliest best before, and the sticker alias of 15OCT26 / 27OCT26 unless that sticker
// code is already in the ledger for the flavour. A code the old Rename lot emptied ("Lot renamed X to Y" COUNT_FIX pair) is no lot of
// its own: it is an alias of the last lot of its rename chain (stock_lot_renames). The practice copy and the tests stand in for the
// backfill with this; the PGlite verify script checks it gives exactly what the SQL gives.
const LETTER = { 'atta-original': 'O', 'atta-kesari': 'K', 'atta-ajwain': 'A', 'atta-lite-sugar': 'L' };
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const realDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null; };
function bakeOfCode(code) {   // stock_lot_bake_date(): DDMONYY any case, or MNG?-YYMMDD-NN
  let m = /^(\d{2})([A-Za-z]{3})(\d{2})$/.exec(code);
  if (m) { const mo = MON.indexOf(m[2].toUpperCase()); return mo < 0 ? null : realDate(2000 + Number(m[3]), mo + 1, Number(m[1])); }
  m = /^MNG[OKAL]-(\d{2})(\d{2})(\d{2})-\d{2}$/.exec(code);
  return m ? realDate(2000 + Number(m[1]), Number(m[2]), Number(m[3])) : null;
}
// [{ item_slug, old_code, final_code }], as stock_lot_renames(): a code renamed to two different codes, or a cycle, folds nothing.
function renamesOf(movements) {
  const plus = new Map();   // 'slug|note' -> codes with a +N COUNT_FIX line carrying that note
  for (const b of movements || []) if (b.type === 'COUNT_FIX' && b.qty > 0 && b.lot_code != null && b.note != null) { const k = b.item_slug + '|' + b.note; (plus.get(k) || plus.set(k, new Set()).get(k)).add(b.lot_code); }
  const ren = new Map();    // 'slug|old' -> Set of new codes
  for (const a of movements || []) {
    if (a.type !== 'COUNT_FIX' || !(a.qty < 0) || a.lot_code == null || a.note == null) continue;
    for (const y of plus.get(a.item_slug + '|' + a.note) || []) if (a.note === 'Lot renamed ' + a.lot_code + ' to ' + y) { const k = a.item_slug + '|' + a.lot_code; (ren.get(k) || ren.set(k, new Set()).get(k)).add(y); }
  }
  const out = [];
  for (const [k, ys] of ren) {
    const slug = k.slice(0, k.indexOf('|')), old = k.slice(k.indexOf('|') + 1);
    if (ys.size !== 1) continue;
    let cur = [...ys][0]; const path = new Set([old]); let ok = true;
    while (ren.has(slug + '|' + cur)) {
      const next = ren.get(slug + '|' + cur);
      if (next.size !== 1 || path.has(cur)) { ok = false; break; }
      path.add(cur); cur = [...next][0];
      if (path.has(cur)) { ok = false; break; }
    }
    if (ok) out.push({ item_slug: slug, old_code: old, final_code: cur });
  }
  return out;
}
function backfillLots(movements) {
  const folded = renamesOf(movements);
  const pairs = new Map();
  for (const r of movements || []) {
    if (r.lot_code == null) continue;
    const k = r.item_slug + '|' + r.lot_code, e = pairs.get(k) || { item_slug: r.item_slug, lot_code: r.lot_code, best_before: null };
    if (r.best_before && (!e.best_before || r.best_before < e.best_before)) e.best_before = r.best_before;
    pairs.set(k, e);
  }
  const sticker = (e) => {
    const l = LETTER[e.item_slug], s = e.lot_code === '15OCT26' ? '261016' : e.lot_code === '27OCT26' ? '261027' : null;
    if (!l || !s) return [];
    const code = 'MNG' + l + '-' + s + '-01';
    return pairs.has(e.item_slug + '|' + code) ? [] : [code];
  };
  const gone = new Set(folded.map((f) => f.item_slug + '|' + f.old_code));
  const into = (e) => folded.filter((f) => f.item_slug === e.item_slug && f.final_code === e.lot_code).map((f) => f.old_code).sort();
  return [...pairs.values()].filter((e) => !gone.has(e.item_slug + '|' + e.lot_code))
    .map((e) => ({ item_slug: e.item_slug, lot_code: e.lot_code, status: 'released', bake_date: bakeOfCode(e.lot_code), best_before: e.best_before, aliases: [...sticker(e), ...into(e)], delivery_id: null }))
    .sort((a, b) => (a.item_slug < b.item_slug ? -1 : a.item_slug > b.item_slug ? 1 : a.lot_code < b.lot_code ? -1 : a.lot_code > b.lot_code ? 1 : 0));
}

module.exports = { memStore, TYPES, backfillLots, renamesOf };
