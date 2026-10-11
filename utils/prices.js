'use strict';

/**
 * Selling prices, owned by the admin (table product_prices). Cached for 30 s and refreshed right after a change made on this
 * server. Until the table has been read once, or if it cannot be read, the built-in list in catalog.js applies, so the shop
 * never ends up without prices.
 */
const db = require('./database');

const TTL_MS = 30_000;
let table = null;          // { slug: { price, mrp } } or null until the first successful read
let loadedAt = 0;
let inflight = null;

function refresh() {
  if (!inflight) {
    inflight = db.listPrices()
      .then((rows) => {
        const t = {};
        rows.forEach((r) => { t[r.slug] = { price: Number(r.price), mrp: r.mrp == null ? null : Number(r.mrp) }; });
        table = Object.keys(t).length ? t : null;      // an empty table means "not switched on yet": keep the built-in prices
        loadedAt = Date.now();
      })
      .catch((err) => { loadedAt = Date.now() - TTL_MS + 5_000; console.error('[PRICES] could not read product_prices, keeping last known prices:', err.message); })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
async function ensureFresh() { if (Date.now() - loadedAt > TTL_MS) await refresh(); }

const current = () => table;     // null = use built-in prices
const isOn = () => !!table;

async function save({ slug, price, mrp, actor }) {
  await db.setPrice({ slug, price, mrp, actor });
  await refresh();
}

module.exports = { ensureFresh, refresh, current, isOn, save };
