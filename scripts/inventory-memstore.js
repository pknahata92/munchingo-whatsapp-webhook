'use strict';
// In-memory stand-in for the stock tables (tests and the practice admin). Mirrors the database's one-write-per-sale rule.
function memStore(trackingFrom) {
  let id = 0; const mv = [];
  const items = [
    { slug: 'atta-kesari', name: 'Atta Kesari', kind: 'product', unit: 'boxes', low_level: 30, manual_low: false, active: true, sort: 10 },
    { slug: 'atta-original', name: 'Atta Original', kind: 'product', unit: 'boxes', low_level: 30, manual_low: false, active: true, sort: 11 },
    { slug: 'atta-ajwain', name: 'Atta Ajwain', kind: 'product', unit: 'boxes', low_level: 30, manual_low: false, active: true, sort: 12 },
    { slug: 'atta-lite-sugar', name: 'Atta Sugar-Lite', kind: 'product', unit: 'boxes', low_level: 30, manual_low: false, active: true, sort: 13 },
    { slug: 'packing-tape', name: 'Packing tape', kind: 'packaging', unit: 'rolls', low_level: 0, manual_low: false, active: true, sort: 33 },
    { slug: 'goodie-bag', name: 'Transparent goodie bags', kind: 'packaging', unit: 'bags', low_level: 0, manual_low: false, active: true, sort: 50 },
    { slug: 'candle', name: 'Candles (for hampers)', kind: 'packaging', unit: 'candles', low_level: 0, manual_low: false, active: true, sort: 51 },
    { slug: 'shredded-paper', name: 'Coloured shredded paper', kind: 'packaging', unit: 'packs', low_level: 0, manual_low: false, active: true, sort: 52 },
  ];
  const settings = { tracking_from: trackingFrom };
  const uniq = (r) => `${r.ref}|${r.item_slug}|${r.lot_code || ''}|${r.type}`;
  return {
    mv,
    items: async () => items, item: async (s) => items.find((i) => i.slug === s) || null,
    byLot: async () => { const m = {}; mv.forEach((r) => { const k = `${r.item_slug}|${r.lot_code || ''}|${r.best_before || ''}`; (m[k] = m[k] || { item_slug: r.item_slug, lot_code: r.lot_code, best_before: r.best_before, qty: 0 }).qty += r.qty; }); return Object.values(m); },
    insert: async (rows) => { const seen = new Set(mv.filter((r) => r.type === 'SALE' || r.type === 'SALE_UNDO').map(uniq)); rows.forEach((r) => { if ((r.type === 'SALE' || r.type === 'SALE_UNDO') && seen.has(uniq(r))) throw new Error('duplicate key (sale written twice)'); }); rows.forEach((r) => mv.push({ id: ++id, created_at: new Date().toISOString(), reverses_id: null, ...r })); },
    recent: async ({ item_slug, type, since, limit = 50 }) => mv.filter((r) => (!item_slug || r.item_slug === item_slug) && (!type || r.type === type) && (!since || r.created_at >= since)).slice().reverse().slice(0, limit),
    movement: async (i) => mv.find((r) => r.id === i) || null, reversalOf: async (i) => mv.some((r) => r.reverses_id === i),
    updateItem: async (s, f) => Object.assign(items.find((i) => i.slug === s), f), insertItem: async (row) => items.push({ manual_low: false, active: true, ...row }),
    setting: async (k) => settings[k] || null,
    committedMap: {}, pausedList: [],
    committed: async function () { return this.committedMap; }, paused: async function () { return this.pausedList; },
    totals: async function () { const byId = Object.fromEntries(mv.map((r) => [r.id, r])); const t = {}; mv.forEach((r) => { const type = r.reverses_id && byId[r.reverses_id] ? byId[r.reverses_id].type : r.type; const k = r.item_slug + '|' + type; t[k] = (t[k] || 0) + r.qty; }); return Object.keys(t).map((k) => ({ item_slug: k.split('|')[0], type: k.split('|')[1], qty: t[k] })); },
    events: async () => { const m = {}; mv.filter((r) => r.type === 'EXHIBITION' || r.type === 'EXHIBITION_RETURN').forEach((r) => { const k = r.ref + '|' + r.item_slug; const e = m[k] || (m[k] = { ref: r.ref, item_slug: r.item_slug, taken: 0, returned: 0 }); if (r.type === 'EXHIBITION') e.taken += -r.qty; else e.returned += r.qty; }); return Object.values(m); },
    eventRows: async (ref, slug) => mv.filter((r) => r.ref === ref && r.item_slug === slug && (r.type === 'EXHIBITION' || r.type === 'EXHIBITION_RETURN')),
    salesOf: async (o) => mv.filter((r) => (r.type === 'SALE' || r.type === 'SALE_UNDO') && String(r.ref).startsWith(o + '@')),
  };
}

module.exports = { memStore };
