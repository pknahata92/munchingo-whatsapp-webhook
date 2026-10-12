'use strict';

/**
 * Delhivery pincode serviceability (prepaid delivery), used by GET /api/pincode/:pin and by POST /api/checkout.
 *
 * Needs DELHIVERY_API_TOKEN (Delhivery One > Settings > API Setup) in the environment. Prashant adds it on Render himself.
 * Without the token, or if Delhivery is slow/unreachable, serviceable is null ("unknown"): the website then just validates
 * the pincode with India Post and NEVER blocks the customer on an unknown. Only an explicit `false` from Delhivery blocks.
 *
 * Delhivery API: GET {BASE}/c/api/pin-codes/json/?filter_codes=<pin>   header  Authorization: Token <token>
 * Returns { delivery_codes: [ { postal_code: { pin, district, state_code, pre_paid: 'Y'|'N', cod, is_oda, ... } } ] }.
 * An empty delivery_codes array means Delhivery does not serve that pincode at all.
 * Results are cached: 24 h for a definite answer, 5 min for "unknown" so an outage does not hammer the API.
 */
const BASE = process.env.DELHIVERY_API_BASE || 'https://track.delhivery.com';
const TIMEOUT_MS = 6000;
const HOUR = 3600_000;
const cache = new Map();   // pin -> { at, ttl, value }

const STATES = { AN: 'Andaman and Nicobar Islands', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CH: 'Chandigarh', CG: 'Chhattisgarh', CT: 'Chhattisgarh', DD: 'Daman and Diu', DL: 'Delhi', DN: 'Dadra and Nagar Haveli', GA: 'Goa', GJ: 'Gujarat', HP: 'Himachal Pradesh', HR: 'Haryana', JH: 'Jharkhand', JK: 'Jammu and Kashmir', KA: 'Karnataka', KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MH: 'Maharashtra', ML: 'Meghalaya', MN: 'Manipur', MP: 'Madhya Pradesh', MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha', OR: 'Odisha', PB: 'Punjab', PY: 'Puducherry', RJ: 'Rajasthan', SK: 'Sikkim', TG: 'Telangana', TN: 'Tamil Nadu', TR: 'Tripura', UK: 'Uttarakhand', UT: 'Uttarakhand', UP: 'Uttar Pradesh', WB: 'West Bengal' };

const isPin = (p) => /^[1-9][0-9]{5}$/.test(String(p || ''));

async function fetchFromDelhivery(pin) {
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) return { serviceable: null, reason: 'not_configured' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const r = await fetch(`${BASE}/c/api/pin-codes/json/?filter_codes=${pin}`, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined });
    if (!r.ok) return { serviceable: null, reason: `http_${r.status}` };
    const j = await r.json();
    const row = Array.isArray(j.delivery_codes) && j.delivery_codes[0] && j.delivery_codes[0].postal_code;
    if (!row) return { serviceable: false, reason: 'not_in_network' };
    const prepaid = String(row.pre_paid || '').toUpperCase() === 'Y';
    const code = String(row.state_code || '').toUpperCase();
    return {
      serviceable: prepaid, reason: prepaid ? 'ok' : 'no_prepaid_delivery',
      city: row.city || '', district: row.district || '', state: STATES[code] || row.state || '', remote: String(row.is_oda || '').toUpperCase() === 'Y',
    };
  } catch (err) {
    return { serviceable: null, reason: err && err.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally { if (timer) clearTimeout(timer); }
}

async function checkPincode(pinRaw) {
  const pin = String(pinRaw || '').trim();
  if (!isPin(pin)) return { pin, valid: false, serviceable: false, reason: 'bad_format' };
  const hit = cache.get(pin);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const v = { pin, valid: true, ...(await fetchFromDelhivery(pin)) };
  cache.set(pin, { at: Date.now(), ttl: v.serviceable === null ? 5 * 60_000 : 24 * HOUR, value: v });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return v;
}

function clearCache() { cache.clear(); }

module.exports = { checkPincode, isPin, clearCache };
