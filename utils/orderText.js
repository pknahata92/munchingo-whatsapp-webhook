'use strict';

/**
 * Turns a stored order item into plain, packable text. Gift sets are stored with a slug that
 * encodes the chosen flavours (e.g. "trio-gift-set-kesari-lite-sugar-original"); the name alone
 * ("Trio Gift Set") doesn't tell whoever is packing which three boxes to put inside.
 */

const FLAVOURS = [
  { token: 'original', name: 'Atta Original', short: 'Original' },
  { token: 'kesari', name: 'Atta Kesari', short: 'Kesari' },
  { token: 'ajwain', name: 'Atta Ajwain', short: 'Ajwain' },
  { token: 'lite-sugar', name: 'Atta Sugar-Lite', short: 'Sugar-Lite' },
];
const BY_SLUG = {
  'atta-original': FLAVOURS[0], 'atta-kesari': FLAVOURS[1], 'atta-ajwain': FLAVOURS[2], 'atta-lite-sugar': FLAVOURS[3],
};

// Flavours inside one unit of this item, in the order they appear in the slug.
function flavoursOf(item) {
  const slug = String(item.slug || '');
  if (slug === 'full-range-set') return [...FLAVOURS];
  if (slug.startsWith('trio-gift-set')) {
    const rest = slug.slice('trio-gift-set'.length);
    return FLAVOURS
      .map((f) => ({ f, at: rest.search(new RegExp(`(^|-)${f.token}(-|$)`)) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((x) => x.f);
  }
  return BY_SLUG[slug] ? [BY_SLUG[slug]] : [];
}

const isGiftSet = (item) => /^(trio-gift-set|full-range-set)/.test(String(item.slug || ''));

// "Kesari + Sugar-Lite + Original" for a gift set, '' for a single box.
function contentsOf(item) {
  return isGiftSet(item) ? flavoursOf(item).map((f) => f.short).join(' + ') : '';
}

function boxesIn(item) {
  if (item.slug === 'full-range-set') return 4;
  if (String(item.slug || '').startsWith('trio-gift-set')) return 3;
  return 1;
}

// Per-flavour box totals across a list of order items (gift sets expanded) - the real packing list.
function flavourTotals(items) {
  const totals = {};
  for (const it of items || []) {
    const qty = Number(it.quantity) || 0;
    const fl = flavoursOf(it);
    for (const f of fl) totals[f.name] = (totals[f.name] || 0) + qty;
  }
  return totals;
}

module.exports = { flavoursOf, contentsOf, isGiftSet, boxesIn, flavourTotals, FLAVOURS };
