'use strict';

/**
 * Buyer state for the GST invoice (CGST+SGST for Haryana, IGST for everywhere else) and for Zoho Books' place of supply.
 *
 * Problem (16 Oct 2026): an order whose state could not be recognised (typed oddly, blank, or an abbreviation) produced an invoice
 * with no state code; the invoice was treated as inter-state and Zoho Books refused it ("Customer state not recognised"), so the
 * order was missing from the books (MUN/26-27/0009, earlier MUN/26-27/0002).
 *
 * Fix, in three layers (no migration):
 *   1. invoice.js normaliseState() now also accepts abbreviations (UP, MH, HR...), spellings without spaces/dots (Tamilnadu, U.P.)
 *      and common misspellings.
 *   2. Checkout asks this module to fill in the state from the PINCODE when the typed state is not recognised.
 *   3. processPaidOrder does the same just before the invoice is made, for orders that came in some other way.
 * The pincode is looked up with Delhivery (already used for the delivery check) and, if that gives nothing, India Post's public API.
 */
const { normaliseState, parseAddress } = require('./invoice');

const TIMEOUT_MS = 5000;
let lookupOverride = null;            // tests
function setLookup(fn) { lookupOverride = fn; }

async function postOfficeState(pin) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const r = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { signal: ctl ? ctl.signal : undefined });
    if (!r.ok) return '';
    const j = await r.json();
    const po = Array.isArray(j) && j[0] && Array.isArray(j[0].PostOffice) && j[0].PostOffice[0];
    return (po && po.State) || '';
  } catch (_) { return ''; } finally { if (timer) clearTimeout(timer); }
}

/** Pincode -> a state name that normaliseState() recognises, or ''. Never throws. */
async function stateFromPincode(pinRaw) {
  const pin = String(pinRaw || '').trim();
  if (!/^[1-9][0-9]{5}$/.test(pin)) return '';
  try {
    if (lookupOverride) { const s = await lookupOverride(pin); return normaliseState(s) ? s : ''; }
    const d = await require('./delhivery').checkPincode(pin);
    if (d && d.state && normaliseState(d.state)) return d.state;
    const p = await postOfficeState(pin);
    return normaliseState(p) ? p : '';
  } catch (_) { return ''; }
}

/** Checkout: structured parts with a recognised state if at all possible. */
async function fixParts(parts) {
  const p = { ...(parts || {}) };
  if (normaliseState(p.state)) return p;
  const s = await stateFromPincode(p.pincode);
  if (s) { console.log(`[STATE] filled "${p.state || ''}" -> ${s} from pincode ${p.pincode}`); p.state = s; }
  else console.warn(`[STATE] could not recognise state "${p.state || ''}" (pincode ${p.pincode || '-'})`);
  return p;
}

/**
 * Paid order about to be invoiced: if its state is still not recognised, resolve it from the pincode and save it on the order.
 * Returns the order (a copy with the fixed address). Never throws; an unresolvable order is returned unchanged.
 */
async function withResolvedState(order, saveFn) {
  try {
    const a = parseAddress(order && order.delivery_address);
    if (normaliseState(a.state)) return order;
    const s = await stateFromPincode(a.pincode);
    if (!s) { console.warn(`[STATE] ${order && order.order_id}: state "${a.state}" not recognised and no pincode match; the invoice will be inter-state and Zoho will refuse it`); return order; }
    const fixed = { ...(order.delivery_address || {}), state: s, ...(a.pincode ? { pincode: a.pincode } : {}) };
    if (saveFn) { try { await saveFn(order.order_id, fixed); } catch (e) { console.error('[STATE] could not save the fixed address:', e.message); } }
    console.log(`[STATE] ${order.order_id}: state set to ${s} from pincode ${a.pincode} before invoicing`);
    return { ...order, delivery_address: fixed };
  } catch (e) { console.error('[STATE] resolve error:', e.message); return order; }
}

module.exports = { stateFromPincode, fixParts, withResolvedState, setLookup };
