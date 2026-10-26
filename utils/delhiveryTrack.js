'use strict';

/**
 * Where is this Delhivery parcel? Used to send "shipped" only once the courier has collected it, and "delivered" when it arrives.
 *
 * Needs DELHIVERY_API_TOKEN. Optional: DELHIVERY_API_BASE (default https://track.delhivery.com).
 * Delhivery API: GET {BASE}/api/v1/packages/json/?waybill=AWB, header "Authorization: Token ...".
 * Status text lives in ShipmentData[0].Shipment.Status.{Status, StatusType}. The status words below come from Delhivery's partner
 * API as commonly documented, NOT from a live call (October 2026): anything not recognised is 'unknown' and triggers no message.
 */
const BASE = process.env.DELHIVERY_API_BASE || 'https://track.delhivery.com';
const TIMEOUT_MS = 15000;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

// booked = manifested, courier has not collected it; picked_up = collected / moving; out_for_delivery; delivered; returning = RTO.
function stageOf(status) {
  if (!status || typeof status !== 'object') return 'unknown';
  const word = norm(status.Status), type = String(status.StatusType || '').toUpperCase();
  if (type === 'RT' || /\b(rto|return|returned|returning)\b/.test(word)) return 'returning';
  if (type === 'DL' || word === 'delivered') return 'delivered';
  if (/^(dispatched|out for delivery)$/.test(word)) return 'out_for_delivery';
  if (/^(manifested|not picked|pickup pending|pickup scheduled|pickup requested|pickup not done|pickup not attempted)$/.test(word) || type === 'PP') return 'booked';
  if (/^(in transit|pending|picked up|reached .*|.*in transit.*)$/.test(word) || type === 'PU') return 'picked_up';
  return 'unknown';
}

// Delhivery's delivery date for the parcel, as an ISO string, or null. The promised date wins over the expected one.
// Field names: the tracking API as documented (PromisedDeliveryDate / ExpectedDeliveryDate, India time when no zone is given),
// and Delhivery One's snake_case milliseconds (seen live 27 Oct 2026 for MNG-QXUA-1210). Empty dates (0, 1970) are ignored.
const EDD_KEYS = ['PromisedDeliveryDate', 'promised_delivery_date', 'ExpectedDeliveryDate', 'expected_delivery_date', 'estimated_delivery_date'];
function eddOf(shipment) {
  if (!shipment || typeof shipment !== 'object') return null;
  for (const k of EDD_KEYS) {
    const v = shipment[k];
    if (v == null || v === '' || v === 0) continue;
    let ms = NaN;
    if (typeof v === 'number') ms = v;
    else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(String(v).trim())) ms = Date.parse(String(v).trim().replace(' ', 'T') + '+05:30');
    else ms = Date.parse(String(v));
    if (!Number.isFinite(ms) || ms < Date.parse('2020-01-01T00:00:00Z')) continue;
    return new Date(ms).toISOString();
  }
  return null;
}

async function fetchStage(awb) {
  const id = String(awb || '').trim();
  if (!/^[0-9]{8,20}$/.test(id)) return { stage: 'unknown', error: 'Invalid awb' };
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) return { stage: 'unknown', error: 'DELHIVERY_API_TOKEN is not set' };
  try {
    const res = await fetch(`${BASE}/api/v1/packages/json/?waybill=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
    });
    const text = await res.text();
    if (!res.ok) return { stage: 'unknown', error: `Delhivery said ${res.status}` };
    let json; try { json = JSON.parse(text); } catch { return { stage: 'unknown', error: 'Delhivery sent something unreadable' }; }
    const shipment = json && json.ShipmentData && json.ShipmentData[0] && json.ShipmentData[0].Shipment;
    const status = shipment && shipment.Status;
    if (!status) return { stage: 'unknown', error: 'Delhivery has no status for this tracking number' };
    return { stage: stageOf(status), status, edd: eddOf(shipment) };
  } catch (e) { return { stage: 'unknown', error: e.message || 'Could not reach Delhivery' }; }
}

module.exports = { stageOf, fetchStage, eddOf };
