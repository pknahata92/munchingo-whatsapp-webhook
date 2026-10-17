/* Pick-list footer: says which orders a pick list covers and which it left out, and why, so the totals can always be reconciled.
 * Runs in the admin page and in node (scripts/pickfooter-test.js). Pure: no DOM, no network.
 *   MngPickFooter.build(coveredIds, allOrders) -> [{ key, why, count, ids }]   (groups of the orders that are NOT on the list)
 * allOrders are the admin's order rows ({ id, state }). Orders that are shipped or delivered are only counted; the others are named,
 * because those are the ones someone might expect to find on a pick list.
 */
(function (root) {
  'use strict';
  var WHY = {
    topack: 'to pack, but not ticked for this list', packed: 'packed, but not ticked for this list', unpaid: 'waiting for payment',
    test: 'test order (not a customer order, never packed)', refunded: 'cancelled or refunded', cancelled: 'cancelled',
    shipped: 'already shipped', delivered: 'already delivered',
  };
  var ORDER = ['topack', 'packed', 'unpaid', 'test', 'refunded', 'cancelled', 'shipped', 'delivered'];
  var NAMED = { topack: 1, packed: 1, unpaid: 1, test: 1, refunded: 1, cancelled: 1 };
  var MAX_IDS = 40;

  function build(coveredIds, orders) {
    var covered = {}; (coveredIds || []).forEach(function (id) { covered[id] = 1; });
    var groups = {};
    (orders || []).forEach(function (o) { if (covered[o.id]) return; (groups[o.state] = groups[o.state] || []).push(o.id); });
    var keys = ORDER.filter(function (k) { return groups[k]; }).concat(Object.keys(groups).filter(function (k) { return ORDER.indexOf(k) < 0; }));
    return keys.map(function (k) { return { key: k, why: WHY[k] || k, count: groups[k].length, ids: NAMED[k] ? groups[k].slice(0, MAX_IDS) : [], more: NAMED[k] ? Math.max(0, groups[k].length - MAX_IDS) : 0 }; });
  }

  var api = { build: build, WHY: WHY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MngPickFooter = api;
})(typeof window !== 'undefined' ? window : this);
