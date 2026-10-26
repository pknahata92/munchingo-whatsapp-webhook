'use strict';
// "Connect me to a person": does this WhatsApp message ask for the owner, an agent or any human?
// Strong phrases match anywhere. A bare role word (agent, owner, manager ...) only counts in a short message, so an
// address or an order note that merely contains "manager" is left alone. English, Hinglish and Hindi.
const STRONG = [
  /\bhuman\b/, /\breal (person|people|human)\b/, /\blive (agent|chat|person)\b/, /\bcustomer (care|service|support)\b/, /\bsupport\b/,
  /\b(talk|speak|chat|connect|connected|connecting|transfer|put)\b.{0,25}\b(person|people|someone|somebody|agent|owner|founder|manager|team|representative|executive|staff|prashant|admin|human)\b/,
  /\b(owner|founder|manager|agent|representative|executive)\b.{0,12}\b(please|pls|plz|now|today|asap|number|contact)\b/,
  /\b(call|phone|ring)\s*(me|back)\b/, /\bcall\s+(karo|kro|karna|krna)\b/, /\bcallback\b|\bcall back\b/,
  /\b(baat|baatcheet|bat)\s*(karni|karna|karo|kro|krni|krna|karwa|karao|kara)\b/, /\bbaat\b.{0,20}\b(owner|malik|insaan|aadmi|agent|manager|team)\b/,
  /\b(owner|malik|insaan|aadmi|kisi)\b.{0,12}\b(se|ko)\b.{0,12}\b(baat|call|milna|connect)\b/, /\binsaan\b|\binsan\b/,
  /बात\s*(करनी|करना|करो|करवा|कराओ)/, /(मालिक|ओनर|इंसान|एजेंट|मैनेजर|ग्राहक सेवा|कस्टमर केयर)/, /किसी से बात/, /कॉल\s*(करो|करना|कीजिए|कर दो)/,
];
const WEAK = /\b(agent|owner|founder|manager|representative|rep|executive|someone|somebody|person|malik|insaan|team)\b/;

function wantsHuman(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (STRONG.some((r) => r.test(t))) return true;
  const words = t.split(/\s+/).filter(Boolean).length;
  return words <= 5 && !/[0-9,]/.test(t) && WEAK.test(t);   // no digits or commas: that is an address or a note, not a request
}

module.exports = { wantsHuman };
