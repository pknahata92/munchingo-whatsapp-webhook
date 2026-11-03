'use strict';

/**
 * Meta catalogue client: reads the four flavours by retailer ID and pushes availability and prices with items_batch.
 * Needs META_CATALOG_TOKEN (Prashant adds it on Render; Claude never sees it).
 * The token travels only in the Authorization header: never in a URL, a param or an error message.
 * `http` is axios-compatible: http(config) resolves { data }. Tests pass a fake, so nothing here touches the network on its own.
 */
const { META_IDS, toMeta, fromMeta } = require('./shape');

const GRAPH = 'https://graph.facebook.com/v21.0';   // same version as utils/serverTracking.js
const CATALOG_ID = '1592646269154053';
const TIMEOUT_MS = 15000;
const SLUG_OF = Object.fromEntries(Object.entries(META_IDS).map(([slug, id]) => [id, slug]));

function makeMeta({ http = require('axios'), token = process.env.META_CATALOG_TOKEN, catalogId = CATALOG_ID } = {}) {
  const configured = () => !!token;
  const ready = () => { if (!token) throw new Error('meta: token not set'); };
  const fail = (msg) => new Error(`meta: ${String(msg || 'request failed').split(token).join('[token]')}`);

  // One Graph call. A failure (HTTP error, network error or an { error } body) becomes Error('meta: <message>').
  async function call(config) {
    let data;
    try {
      ({ data } = await http({ ...config, headers: { Authorization: `Bearer ${token}` }, timeout: TIMEOUT_MS }));
    } catch (e) {
      const graph = e.response && e.response.data && e.response.data.error;
      throw fail((graph && graph.message) || e.message);
    }
    if (data && data.error) throw fail(data.error.message);
    return data || {};
  }

  // { [slug]: { availability, price, mrp } | null }, null meaning Meta has no such item.
  async function read(slugs) {
    ready();
    const out = {};
    const ids = [];
    slugs.forEach((slug) => { if (META_IDS[slug]) { out[slug] = null; ids.push(META_IDS[slug]); } });
    if (!ids.length) return out;
    const data = await call({
      method: 'GET', url: `${GRAPH}/${catalogId}/products`,
      params: { fields: 'retailer_id,availability,price,sale_price', limit: 25, filter: JSON.stringify({ retailer_id: { is_any: ids } }) },
    });
    (data.data || []).forEach((item) => { const slug = SLUG_OF[item.retailer_id]; if (slug && slug in out) out[slug] = fromMeta(item); });
    return out;
  }

  // items: [{ slug, state }]. Meta takes the batch asynchronously: ok means accepted; the next read shows whether it landed.
  // allow_upsert false: Graph's default (true) lets an UPDATE create an item that is missing; a missing item is reported, never made.
  async function push(items) {
    ready();
    if (!items.length) return { ok: true, handles: [] };
    const requests = items.map(({ slug, state }) => ({ method: 'UPDATE', data: toMeta(slug, state) }));
    const data = await call({ method: 'POST', url: `${GRAPH}/${catalogId}/items_batch`, data: { item_type: 'PRODUCT_ITEM', allow_upsert: false, requests: JSON.stringify(requests) } });
    return { ok: true, handles: data.handles || [] };
  }

  return { configured, read, push };
}

module.exports = { makeMeta, client: () => makeMeta({}) };
