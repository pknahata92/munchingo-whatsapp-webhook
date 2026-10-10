'use strict';

// Minimal in-memory fixed-window rate limiter, keyed by client IP.
// No new dependency, no persistence needed - this is a single-instance
// Render service, so in-memory state is fine for basic abuse protection
// (e.g. someone scripting POST /api/checkout to spam orders/emails/Razorpay
// payment links). Not a replacement for a CDN-level limiter, but stops
// casual abuse.

function rateLimit({ windowMs = 60_000, max = 10 } = {}) {
  const hits = new Map(); // ip -> [timestamps]; one map PER limiter so routes with different windows don't trim each other
  return function (req, res, next) {
    // req.ip honours `trust proxy` (set in server.js): the address Render's proxy saw, not a header the caller can fake.
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    const timestamps = (hits.get(ip) || []).filter((t) => t > windowStart);
    if (timestamps.length >= max) {
      return res.status(429).json({ ok: false, error: 'Too many requests. Please try again in a minute.' });
    }

    timestamps.push(now);
    hits.set(ip, timestamps);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || v[v.length - 1] <= windowStart) hits.delete(k);   // keep memory bounded
    next();
  };
}

module.exports = { rateLimit };
