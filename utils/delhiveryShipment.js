'use strict';

/**
 * Create a Delhivery shipment (prepaid, surface) for a paid order and return its AWB (waybill).
 * Used by POST /admin/api/orders/:id/delhivery-shipment, which then marks the order shipped.
 *
 * Needs DELHIVERY_API_TOKEN (same token as the pincode check). Optional env:
 *   DELHIVERY_PICKUP_LOCATION  name of the pickup location in Delhivery One (default 'Munchingo', Faridabad 121007)
 *   DELHIVERY_API_BASE         default https://track.delhivery.com
 * Delhivery API: POST {BASE}/api/cmu/create.json  (form body: format=json&data=<json>)  header  Authorization: Token <token>
 * Success: { success: true, packages: [ { waybill, status: 'Success', refnum, ... } ] }. Failure: packages[0].remarks / rmk.
 * Creating a shipment charges the Delhivery wallet. Pickup is NOT requested here (do that in Delhivery One).
 */
const BASE = process.env.DELHIVERY_API_BASE || 'https://track.delhivery.com';
const TIMEOUT_MS = 15000;
const SELLER = { name: 'Munchingo', gstin: '06AIIPN5005C2ZP', hsn: '1905' };

// Packed weight in grams = 250 g per box + packaging (mailer, filler, slip, tape). MEASURED by Prashant on 17 Oct 2026: a 3-box parcel
// weighs 1,220 g and (18 Oct) a 4-box parcel stays under 1,600 g, so 1,600 g is used (600 g of packaging). Declared weight barely matters:
// every parcel is billed on the 1,678 g volumetric weight of the 8 in box unless it weighs more than that. The 1-box and 2-box figures are NOT measured (guesses).
// VOLUMETRIC WEIGHT (L x W x H cm / 5000): the 8 in cube is 1,678 g, more than 1-2 boxes weigh, so a cube parcel bills in the 2 kg slab.
// NEW CARTONS (Prashant, 27 Oct 2026): 3 boxes ship in a 6 x 6 x 8 in carton (938 g volumetric, so the 1,220 g real weight bills: the
// 1.5 kg slab) and 4 boxes in a 6 x 8 x 8 in carton (1,253 g volumetric). The 4-box weight stays 1,600 g (2 kg slab) until a 4-box
// parcel in the new carton is weighed: declaring less than the real weight makes Delhivery re-weigh and bill the difference.
// 1 and 2 boxes still go in the cube until Prashant confirms they ship in the 6 x 6 x 8 in carton (with filler).
// The admin lets staff overwrite the weight per order.
const PACKAGING_G = { 1: 350, 2: 420, 3: 470, 4: 600 };
const SIZE_CM = { 1: [20.3, 20.3, 20.3], 2: [20.3, 20.3, 20.3], 3: [20.3, 15.2, 15.2], 4: [20.3, 20.3, 15.2] };   // cube for 1-2 boxes; 6x6x8 in and 6x8x8 in cartons for 3 and 4 (27 Oct)
const MAX_BOXES = 4;   // 5+ boxes ship as two parcels (decided 12 Oct): book those in Delhivery One

// The Pack of 2 (25 Oct 2026): a snug 2-box mailer, about 20 x 15 x 10 cm and 660 g packed, bills in the 1 kg slab instead of the 2 kg cube slab
// (about Rs 40 to Rs 90 less per parcel). It is OFF until DELHIVERY_2BOX_MAILER=1 is set on Render, because the declared size must match
// the real parcel: a smaller declared size than the real one makes Delhivery re-weigh and bill the difference. Set it only once the mailers are in use.
const mailer2 = (boxes) => boxes === 2 && /^(1|true|yes)$/i.test(String(process.env.DELHIVERY_2BOX_MAILER || ''));
const MAILER_2BOX_CM = [20, 15, 10];
const MAILER_2BOX_PACKAGING_G = 160;
const sizeFor = (boxes) => (mailer2(boxes) ? MAILER_2BOX_CM : SIZE_CM[boxes]);
const estimateWeight = (boxes) => 250 * boxes + (mailer2(boxes) ? MAILER_2BOX_PACKAGING_G : (PACKAGING_G[boxes] || 0));

const clean = (s, n) => String(s || '').replace(/[&#%;\\\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const tenDigits = (p) => String(p || '').replace(/\D/g, '').slice(-10);

class ShipmentError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

// Pure: turns an order (database row) + shaped admin view into Delhivery's request payload.
function buildPayload({ order, shaped, weightGrams, pickupLocation }) {
  const boxes = shaped.boxes;
  if (!(boxes >= 1)) throw new ShipmentError('This order has no boxes to ship.');
  if (boxes > MAX_BOXES) throw new ShipmentError(`${boxes} boxes ship as two parcels. Book those in Delhivery One, then enter the AWBs under "Mark shipped".`);
  const addr = order.delivery_address || {};
  const raw = clean(addr.raw, 230);
  const pin = String(addr.pincode || '').trim() || ((raw.match(/\b[1-9]\d{5}\b/g) || []).pop() || '');
  if (!/^[1-9]\d{5}$/.test(pin)) throw new ShipmentError('This address has no valid 6-digit pincode. Fix the address first.');
  const phone = tenDigits(shaped.ship_phone);
  if (phone.length !== 10) throw new ShipmentError('The delivery phone number is not a valid 10-digit number.');
  const weight = Math.round(Number(weightGrams) || estimateWeight(boxes));
  if (!(weight >= 100 && weight <= 5000)) throw new ShipmentError('Weight must be between 100 and 5000 grams.');
  const [length, width, height] = sizeFor(boxes);
  return {
    shipments: [{
      name: clean(shaped.ship_name, 80), add: raw, pin, city: clean(addr.city, 60), state: clean(addr.state, 60), country: 'India', phone,
      order: order.order_id, payment_mode: 'Prepaid', cod_amount: '0', total_amount: String(Math.round(Number(order.total))),
      products_desc: clean(shaped.items.map((i) => `${i.name} x${i.qty}`).join(', '), 200), quantity: String(boxes),
      weight: String(weight), shipment_length: String(length), shipment_width: String(width), shipment_height: String(height),
      shipping_mode: 'Surface', seller_name: SELLER.name, seller_gst_tin: SELLER.gstin, hsn_code: SELLER.hsn,
    }],
    pickup_location: { name: pickupLocation || process.env.DELHIVERY_PICKUP_LOCATION || 'Munchingo' },
  };
}

async function createShipment({ order, shaped, weightGrams }) {
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) throw new ShipmentError('DELHIVERY_API_TOKEN is not set on Render, so shipments cannot be created from here.', 503);
  const payload = buildPayload({ order, shaped, weightGrams });
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  let r; let text;
  try {
    r = await fetch(`${BASE}/api/cmu/create.json`, {
      method: 'POST', signal: ctl ? ctl.signal : undefined,
      headers: { Authorization: `Token ${token}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ format: 'json', data: JSON.stringify(payload) }).toString(),
    });
    text = await r.text();
  } catch (err) {
    throw new ShipmentError(err && err.name === 'AbortError' ? 'Delhivery did not answer in time. Check Delhivery One before trying again.' : 'Could not reach Delhivery.', 502);
  } finally { if (timer) clearTimeout(timer); }
  let j = {}; try { j = JSON.parse(text); } catch (e) { /* non-JSON body */ }
  const pkg = Array.isArray(j.packages) && j.packages[0];
  if (r.ok && j.success !== false && pkg && pkg.waybill && String(pkg.status || 'Success').toLowerCase() === 'success') {
    return { awb: String(pkg.waybill), weight: Number(payload.shipments[0].weight), pickup: payload.pickup_location.name };
  }
  const why = (pkg && (Array.isArray(pkg.remarks) ? pkg.remarks.join(' ') : pkg.remarks)) || j.rmk || j.error || (r.status === 401 ? 'Delhivery rejected the API token.' : `Delhivery answered ${r.status}.`);
  throw new ShipmentError(`Delhivery did not create the shipment: ${clean(why, 300)}`, 502);
}

module.exports = { createShipment, buildPayload, estimateWeight, ShipmentError, MAX_BOXES };
