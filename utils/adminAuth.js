'use strict';

/**
 * Admin login without passwords or extra services.
 *   1. POST /admin/api/login  { email }        -> if the address is allowed, a 6-digit code is emailed to it
 *   2. POST /admin/api/verify { email, code }  -> returns a signed session token (12 h)
 * Codes are derived (HMAC) from the email and a 5-minute window, so nothing is stored; a code works for 5-10 minutes.
 * Sessions are stateless signed tokens. Everything is keyed from ADMIN_SECRET, falling back to DIGEST_SECRET (already on Render).
 * Allowed emails: ADMIN_EMAILS (comma separated), defaulting to NOTIFY_EMAIL.
 */
const crypto = require('crypto');

const WINDOW_MS = 5 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;

const key = () => process.env.ADMIN_SECRET || process.env.DIGEST_SECRET || '';
const hmac = (msg) => crypto.createHmac('sha256', key()).update(msg).digest();
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function allowedEmails() {
  const raw = process.env.ADMIN_EMAILS || process.env.NOTIFY_EMAIL || '';
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}
const isAllowed = (email) => !!key() && allowedEmails().includes(String(email || '').trim().toLowerCase());

function codeFor(email, win) {
  const n = hmac(`otp|${String(email).toLowerCase()}|${win}`).readUInt32BE(0) % 1000000;
  return String(n).padStart(6, '0');
}
const currentWindow = () => Math.floor(Date.now() / WINDOW_MS);
const issueCode = (email) => codeFor(email, currentWindow());

// Brute-force guard: 8 wrong codes per email locks it for 15 minutes (in memory, resets on restart: acceptable).
const fails = new Map();
function locked(email) {
  const f = fails.get(email);
  if (!f) return false;
  if (Date.now() > f.until) { fails.delete(email); return false; }
  return f.count >= 8;
}
function noteFail(email) {
  const f = fails.get(email) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
  f.count += 1; fails.set(email, f);
}

function verifyCode(email, code) {
  const e = String(email || '').trim().toLowerCase();
  if (!isAllowed(e) || locked(e)) return false;
  const w = currentWindow();
  const ok = eq(String(code || '').trim(), codeFor(e, w)) || eq(String(code || '').trim(), codeFor(e, w - 1));
  if (!ok) noteFail(e); else fails.delete(e);
  return ok;
}

function issueToken(email) {
  const payload = Buffer.from(JSON.stringify({ e: String(email).toLowerCase(), exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${payload}.${hmac(`session|${payload}`).toString('base64url')}`;
}

function readToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig || !eq(sig, hmac(`session|${payload}`).toString('base64url'))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || Date.now() > data.exp || !isAllowed(data.e)) return null;
    return { email: data.e };
  } catch (_) { return null; }
}

// Express middleware for /admin/api/*
function requireAdmin(req, res, next) {
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  const who = m && readToken(m[1]);
  if (!who) return res.status(401).json({ ok: false, error: 'Please sign in again.' });
  req.admin = who;
  next();
}

module.exports = { isAllowed, issueCode, verifyCode, issueToken, readToken, requireAdmin, locked };
