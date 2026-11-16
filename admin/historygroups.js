/* Stock history grouping: the ledger keeps one row per flavour (and per lot), but one take-out, hamper sale or receipt is ONE action.
 * Rows saved together share the exact same created_at (one database insert), so rows with the same time, type, buyer/reference, note,
 * person and delivery are shown as one entry. Reversal lines are never merged. Display only: nothing is written or changed.
 * Runs in the browser (admin > Stock > History) and in node (scripts/history-groups-test.js).
 */
(function (root) {
  'use strict';
  function keyOf(m) {
    return [m.created_at, m.type, m.ref || '', m.party || '', m.note || '', m.actor_name || '', m.delivery_id == null ? '' : m.delivery_id].join('␟');
  }
  // rows: newest first, as the server returns them. opts.truncated: the list was cut by the row limit, so the last entry may be incomplete.
  function group(rows, opts) {
    var list = Array.isArray(rows) ? rows : [], out = [], byKey = {};
    list.forEach(function (m, i) {
      var merge = !m.reverses_id && m.type !== 'REVERSAL';
      var k = merge ? keyOf(m) : 'single' + i;
      var e = byKey[k];
      if (!e) {
        e = byKey[k] = { rows: [], boxes: [], total: 0, created_at: m.created_at, type: m.type, ref: m.ref || null, party: m.party || null, note: m.note || null, actor_name: m.actor_name || null, delivery_id: m.delivery_id == null ? null : m.delivery_id };
        out.push(e);
      }
      e.rows.push(m);
      var q = Math.abs(Number(m.qty) || 0), b = null;
      for (var j = 0; j < e.boxes.length; j++) if (e.boxes[j].slug === m.item_slug) b = e.boxes[j];
      if (!b) { b = { slug: m.item_slug, qty: 0 }; e.boxes.push(b); }
      b.qty += q; e.total += q;
    });
    out.forEach(function (e) {
      var n = e.rows.filter(function (r) { return r.reversed; }).length;
      e.someReversed = n > 0; e.allReversed = n === e.rows.length;
    });
    if (opts && opts.truncated && out.length > 1) out.pop();
    return out;
  }
  var api = { group: group };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MunchingoHistoryGroups = api;
})(typeof window !== 'undefined' ? window : this);
