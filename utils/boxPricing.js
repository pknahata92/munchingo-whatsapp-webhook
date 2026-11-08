'use strict';
// The one price rule for every gift box (Prashant, 9 Nov 2026): a box of 3 is its singles less 8%, a box of 4 less 12.5%,
// rounded so the price ends in 9. Set prices are never stored or typed in: they always come from the singles through here.
const BOX_DISCOUNT = { 3: 0.08, 4: 0.125 };

/** Price of a box holding these single-box slugs; priceOf(slug) is the current single price. Throws on a size or slug the rule does not cover. */
function boxPrice(singleSlugs, priceOf) {
  const { BASE_SLUGS } = require('./catalog');
  const d = BOX_DISCOUNT[singleSlugs.length];
  if (d === undefined) throw new Error('No box rule for ' + singleSlugs.length + ' boxes');
  if (!singleSlugs.every((s) => BASE_SLUGS.includes(s))) throw new Error('Box rule needs single-box slugs');
  const total = singleSlugs.reduce((sum, s) => sum + priceOf(s), 0);
  return Math.floor((total * (1 - d) + 1) / 10) * 10 - 1;
}

/** The 3 single-box slugs inside a Trio slug, or null when the slug is not a valid Trio. */
function mixOf(slug) {
  const { isValidTrioSlug } = require('./catalog');
  if (!isValidTrioSlug(slug)) return null;
  const tokens = [];
  let rest = slug.slice('trio-gift-set-'.length);
  while (rest) {
    const t = ['ajwain', 'kesari', 'lite-sugar', 'original'].find((tok) => rest === tok || rest.startsWith(tok + '-'));
    tokens.push(t);
    rest = rest.slice(t.length + 1);
  }
  return tokens.map((t) => 'atta-' + t);
}

/** Every canonical Trio slug (each leaves out one of the four flavours). */
function allTrioMixes() {
  const tokens = ['ajwain', 'kesari', 'lite-sugar', 'original'];
  return tokens.map((skip) => 'trio-gift-set-' + tokens.filter((t) => t !== skip).join('-'));
}

module.exports = { BOX_DISCOUNT, boxPrice, mixOf, allTrioMixes };
