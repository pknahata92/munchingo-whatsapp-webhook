'use strict';

/**
 * Fetch the Delhivery shipping label (PDF, 4x6 in) for one AWB, used by POST /admin/api/labels.
 *
 * Delhivery API: GET {BASE}/api/p/packing_slip?wbns=<awb>&pdf=true&pdf_size=4R   header  Authorization: Token <token>
 * Depending on the account/version it answers either the PDF itself or JSON carrying a download link
 * (pdf_download_link / pdf_url). Both are handled. Needs DELHIVERY_API_TOKEN (same token as shipment creation).
 * If '4R' is refused it retries once without a size (Delhivery's default). Anything that is not a real PDF is an error.
 */
const BASE = process.env.DELHIVERY_API_BASE || 'https://track.delhivery.com';
const TIMEOUT_MS = 20000;
const MAX_BYTES = 5 * 1024 * 1024;

class LabelError extends Error { constructor(msg, status = 502) { super(msg); this.status = status; } }

const isPdf = (buf) => buf && buf.length > 5 && buf.slice(0, 5).toString('latin1') === '%PDF-';
const isAwb = (s) => /^[0-9]{8,20}$/.test(String(s || '').trim());

async function timed(url, headers) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try { return await fetch(url, { headers, signal: ctl ? ctl.signal : undefined }); }
  finally { if (timer) clearTimeout(timer); }
}

async function body(r) {
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new LabelError('The label file was unexpectedly large.');
  return buf;
}

async function attempt(awb, size, token) {
  const url = `${BASE}/api/p/packing_slip?wbns=${encodeURIComponent(awb)}&pdf=true${size ? `&pdf_size=${size}` : ''}`;
  const headers = { Authorization: `Token ${token}`, Accept: 'application/pdf, application/json' };
  const r = await timed(url, headers);
  if (r.status === 401 || r.status === 403) throw new LabelError('Delhivery rejected the API token.', 502);
  if (!r.ok) return { fail: `Delhivery answered ${r.status}.` };
  const buf = await body(r);
  if (isPdf(buf)) return { pdf: buf };
  let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch (e) { /* not JSON */ }
  const link = j && (j.pdf_download_link || j.pdf_url || (j.packages && j.packages[0] && (j.packages[0].pdf_download_link || j.packages[0].pdf_url)));
  if (link) {
    let u; try { u = new URL(String(link)); } catch (e) { return { fail: 'Delhivery sent an unreadable download link.' }; }
    if (u.protocol !== 'https:' || /^(localhost|\d+\.\d+\.\d+\.\d+|\[)/i.test(u.hostname)) return { fail: 'Delhivery sent an unexpected download link.' };
    const r2 = await timed(u.toString(), { Accept: 'application/pdf' });
    if (!r2.ok) return { fail: `The label download answered ${r2.status}.` };
    const b2 = await body(r2);
    if (isPdf(b2)) return { pdf: b2 };
    return { fail: 'The downloaded label was not a PDF.' };
  }
  const why = j && (j.error || j.message || (Array.isArray(j.packages) && j.packages.length === 0 && 'Delhivery has no label for this AWB yet.'));
  return { fail: String(why || 'Delhivery did not return a label.').slice(0, 200) };
}

// Returns a Buffer holding the label PDF, or throws LabelError with a plain-words reason.
async function fetchLabel(awbRaw) {
  const awb = String(awbRaw || '').trim();
  if (!isAwb(awb)) throw new LabelError('This order has no Delhivery tracking number.', 400);
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) throw new LabelError('DELHIVERY_API_TOKEN is not set on Render.', 503);
  let last = '';
  for (const size of ['4R', null]) {
    try {
      const r = await attempt(awb, size, token);
      if (r.pdf) return r.pdf;
      last = r.fail;
    } catch (err) {
      if (err instanceof LabelError) throw err;
      last = err && err.name === 'AbortError' ? 'Delhivery did not answer in time.' : 'Could not reach Delhivery.';
    }
  }
  throw new LabelError(last || 'Delhivery did not return a label.');
}

module.exports = { fetchLabel, LabelError, isAwb };
