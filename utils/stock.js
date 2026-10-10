'use strict';

/**
 * Sold-out switch. The owner toggles flavours in the admin (table product_stock); catalog.isAvailable reads the cached list.
 * The cache is refreshed at most every 30 s and right after any change made on this server. If the database cannot be
 * read, the last known list is kept; before the first successful read the hard-coded list in catalog.js applies.
 */
const db = require('./database');

const TTL_MS = 30_000;
let soldOut = null;        // array of base slugs, or null until the first successful read
let loadedAt = 0;
let inflight = null;

function refresh() {
  if (!inflight) {
    inflight = db.listStock()
      .then((rows) => { soldOut = rows.filter((r) => r.available === false).map((r) => r.slug); loadedAt = Date.now(); })
      .catch((err) => { loadedAt = Date.now() - TTL_MS + 5_000; console.error('[STOCK] could not read product_stock, keeping last known list:', err.message); })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Call before reading isAvailable() in an async request handler; cheap when the cache is fresh.
async function ensureFresh() { if (Date.now() - loadedAt > TTL_MS) await refresh(); }

// null = not loaded yet (catalog falls back to its hard-coded list)
const soldOutSlugs = () => soldOut;

async function setAvailable(slug, available, who, note) {
  await db.setStock(slug, available, who, note);
  await refresh();
}

module.exports = { ensureFresh, refresh, soldOutSlugs, setAvailable };
