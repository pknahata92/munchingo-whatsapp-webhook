'use strict';

/**
 * Sold-out list used by the shop. A flavour is sold out when it is PAUSED by hand (table product_stock, the Pause selling switch in
 * Inventory) or when the stock ledger says nothing is left to sell (utils/inventory.js sellable); catalog.isAvailable reads the list.
 * The cache is refreshed at most every 30 s and right after any change made on this server. If the database cannot be
 * read, the last known list is kept; before the first successful read the hard-coded list in catalog.js applies.
 */
const db = require('./database');

const TTL_MS = 30_000;
let soldOut = null;        // manually paused base slugs (product_stock), or null until the first successful read
let autoOut = [];          // base slugs with nothing left to sell (stock ledger), recomputed on every refresh
let sellableMap = null;    // { slug: boxes still sellable } for flavours that have stock recorded; null = unknown
let loadedAt = 0;
let inflight = null;

function refresh() {
  if (!inflight) {
    inflight = db.listStock()
      .then(async (rows) => {
        soldOut = rows.filter((r) => r.available === false).map((r) => r.slug); loadedAt = Date.now();
        // Automatic sold-out from the stock ledger. Any failure keeps the last known answer and never blocks the shop.
        try { const m = await require('./inventory').instance().sellable(); sellableMap = m; autoOut = Object.keys(m).filter((k) => m[k] <= 0); }
        catch (err) { if (!/stock_ledger_migration/.test(err.message)) console.error('[STOCK] could not compute sellable stock, keeping last known:', err.message); }
      })
      .catch((err) => { loadedAt = Date.now() - TTL_MS + 5_000; console.error('[STOCK] could not read product_stock, keeping last known list:', err.message); })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Call before reading isAvailable() in an async request handler; cheap when the cache is fresh.
// Also keeps the price table fresh: every place that checks stock before pricing a cart gets both in one call.
async function ensureFresh() { await Promise.all([Date.now() - loadedAt > TTL_MS ? refresh() : null, require('./prices').ensureFresh()]); }

// null = not loaded yet (catalog falls back to its hard-coded list)
const soldOutSlugs = () => (soldOut === null ? null : Array.from(new Set([...soldOut, ...autoOut])));
const pausedSlugs = () => soldOut || [];
const autoSoldOutSlugs = () => autoOut;
const sellable = (slug) => (sellableMap && slug in sellableMap ? sellableMap[slug] : null);   // null = not tracked, do not limit

async function setAvailable(slug, available, who, note) {
  await db.setStock(slug, available, who, note);
  await refresh();
}

module.exports = { ensureFresh, refresh, soldOutSlugs, pausedSlugs, autoSoldOutSlugs, sellable, setAvailable };
