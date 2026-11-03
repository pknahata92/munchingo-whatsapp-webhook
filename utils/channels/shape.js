'use strict';

/**
 * What the four flavours should look like on Meta and Google, and the mapping to and from each channel's wording.
 * Pure: no requires, no I/O. Gift sets are not catalogue items and never appear here.
 * Price mapping (both channels): channel price = MRP, channel sale price = web price. No MRP (or MRP <= price): availability only.
 */
const SLUGS = ['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar'];
const META_IDS = { 'atta-original': '91slwpjdqq', 'atta-ajwain': '97q9r5q5q3', 'atta-kesari': 'w2w5ynf2m5', 'atta-lite-sugar': 'vf5p90bcy5' };
const GOOGLE_OFFER_IDS = { 'atta-original': 'MNG-ORIGINAL-250', 'atta-ajwain': 'MNG-AJWAIN-250', 'atta-kesari': 'MNG-KESARI-250', 'atta-lite-sugar': 'MNG-LITE-250' };

// { slug: { availability, price, mrp } } for the four flavours; a flavour with no price entry still gets its availability.
function publicState({ isAvailable, prices }) {
  const out = {};
  SLUGS.forEach((slug) => {
    const p = (prices && prices[slug]) || {};
    const price = p.price == null ? null : Number(p.price);
    const mrp = price != null && p.mrp != null && Number(p.mrp) > price ? Number(p.mrp) : null;
    out[slug] = { availability: isAvailable(slug) ? 'in stock' : 'out of stock', price, mrp };
  });
  return out;
}

// Prices are compared only when we actually want them on the channel (an MRP exists).
function sameState(want, shown) {
  if (want.availability !== shown.availability) return false;
  return want.mrp == null || (want.price === shown.price && want.mrp === shown.mrp);
}

// With no MRP the prices are not sent, so a channel can keep an old price or sale price (a discount that ended). True when what the
// channel shows differs from the web price: such an item is reported, never "matches" (Ruling 15). Availability is judged by sameState.
function priceUnsynced(want, shown) {
  if (!want || !shown || want.mrp != null || want.price == null) return false;
  return shown.price !== want.price || (shown.mrp != null && shown.mrp !== want.price);
}

const amount = (v) => { const n = Math.round(parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''))); return Number.isFinite(n) ? n : null; };
const micros = (n) => String(Math.round(n * 1e6));
const money = (n) => ({ amountMicros: micros(n), currencyCode: 'INR' });

function toMeta(slug, st) {
  const o = { id: META_IDS[slug], availability: st.availability };
  if (st.mrp != null) { o.price = `${st.mrp.toFixed(2)} INR`; o.sale_price = `${st.price.toFixed(2)} INR`; }
  return o;
}

// A Meta item as read back: sale_price present means price is the MRP.
function fromMeta(item) {
  const first = amount(item.price); const sale = amount(item.sale_price);
  return sale != null ? { availability: item.availability, price: sale, mrp: first } : { availability: item.availability, price: first, mrp: null };
}

function toGoogle(st) {
  const o = { availability: st.availability === 'in stock' ? 'IN_STOCK' : 'OUT_OF_STOCK' };
  if (st.mrp != null) { o.price = money(st.mrp); o.salePrice = money(st.price); }
  return o;
}

// A Google product as read back (productAttributes). Availability we never send (PREORDER ...) comes back unmatched on purpose.
function fromGoogle(product) {
  const a = (product && product.productAttributes) || {};
  const m = (x) => (x && x.amountMicros != null ? Number(x.amountMicros) / 1e6 : null);
  const first = m(a.price); const sale = m(a.salePrice);
  return { availability: String(a.availability || '').toLowerCase().replace(/_/g, ' '), price: sale != null ? sale : first, mrp: sale != null ? first : null, title: a.title };
}

module.exports = { SLUGS, META_IDS, GOOGLE_OFFER_IDS, publicState, sameState, priceUnsynced, toMeta, fromMeta, toGoogle, fromGoogle };
