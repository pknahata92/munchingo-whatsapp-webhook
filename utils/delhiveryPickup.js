'use strict';

/**
 * Ask Delhivery to collect parcels that are already manifested (created with utils/delhiveryShipment.js).
 * One request covers a pickup location, a date and a parcel count, not one order.
 *
 * Needs DELHIVERY_API_TOKEN. Optional env:
 *   DELHIVERY_PICKUP_LOCATION  pickup location name (same one the shipments use, default 'Munchingo')
 *   DELHIVERY_PICKUP_TIME      slot start, HH:MM:SS, default 14:00:00 (IST)
 *   DELHIVERY_API_BASE         default https://track.delhivery.com
 * Delhivery API: POST {BASE}/fm/request/new/  JSON body { pickup_time, pickup_date, pickup_location, expected_package_count }
 * Success: { pickup_id, ... }. The field names come from Delhivery's partner API as commonly documented, NOT from a page we could
 * read in October 2026: confirm on the first live request and read the error text the admin shows if it fails.
 */
const BASE = process.env.DELHIVERY_API_BASE || 'https://track.delhivery.com';
const TIMEOUT_MS = 15000;
const CUT_OFF_HOUR_IST = 14;   // after this a same-day pickup is unrealistic, so the request is for tomorrow
const MAX_PARCELS = 100;
const IST_MS = 5.5 * 3600 * 1000;

class PickupError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// Pure: the date (IST) and slot to ask for. Before 14:00 IST today, otherwise tomorrow.
function pickupWhen(now = new Date()) {
  const ist = now.getTime() + IST_MS;
  const hour = new Date(ist).getUTCHours();
  const date = ymd(hour >= CUT_OFF_HOUR_IST ? ist + 24 * 3600 * 1000 : ist);
  const time = /^\d{2}:\d{2}:\d{2}$/.test(process.env.DELHIVERY_PICKUP_TIME || '') ? process.env.DELHIVERY_PICKUP_TIME : '14:00:00';
  return { date, time };
}

async function requestPickup({ count, date, time, now } = {}) {
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) throw new PickupError('DELHIVERY_API_TOKEN is not set on Render, so a pickup cannot be requested from here.', 503);
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARCELS) throw new PickupError(`Parcel count must be a whole number from 1 to ${MAX_PARCELS}.`);
  const when = pickupWhen(now || new Date());
  const pickupDate = date || when.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) throw new PickupError('The pickup date must look like 2026-10-20.');
  const location = process.env.DELHIVERY_PICKUP_LOCATION || 'Munchingo';
  const body = { pickup_time: time || when.time, pickup_date: pickupDate, pickup_location: location, expected_package_count: n };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  let r; let text;
  try {
    r = await fetch(`${BASE}/fm/request/new/`, {
      method: 'POST', signal: ctl ? ctl.signal : undefined,
      headers: { Authorization: `Token ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    text = await r.text();
  } catch (err) {
    throw new PickupError(err && err.name === 'AbortError' ? 'Delhivery did not answer in time. Check Pickup Requests in Delhivery One before trying again.' : 'Could not reach Delhivery.', 502);
  } finally { if (timer) clearTimeout(timer); }
  let j = {}; try { j = JSON.parse(text); } catch (e) { /* non-JSON body */ }
  if (r.ok && j.pickup_id) return { pickupId: String(j.pickup_id), count: n, date: pickupDate, time: body.pickup_time, location };
  const why = j.error || j.message || j.detail || (r.status === 401 ? 'Delhivery rejected the API token.' : r.ok ? 'Delhivery answered without a pickup id. Check Delhivery One before trying again.' : `Delhivery answered ${r.status}.`);
  throw new PickupError(`Delhivery did not book the pickup: ${clean(typeof why === 'string' ? why : JSON.stringify(why), 300)}`, 502);
}

module.exports = { requestPickup, pickupWhen, PickupError, MAX_PARCELS };
