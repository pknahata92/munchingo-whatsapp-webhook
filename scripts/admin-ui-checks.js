'use strict';
// Checks for the redesigned admin, one block per plan task. Each is an async function run by admin-ui-test.js.
module.exports = function checks({ openAdmin, ok, sleep, until }) {
  const list = [];
  const vis = (el) => !!el && !el.hidden && !el.closest('[hidden]');

  // Task 1: shell, tabs, header
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    const tabs = qa('#tabs .tab').filter(vis).map((t) => text(t));
    ok(tabs.join('|') === 'Orders|Stock|More', 'owner sees the tabs Orders, Stock and More (saw: ' + tabs.join('|') + ')');
    ok(['priceBtn', 'couponBtn', 'teamBtn', 'invBtn', 'labelBtn'].every((id) => !o.doc.getElementById(id)), 'the old header tool buttons are gone');
    ok(vis(q('#helpBtn')) && vis(q('#out')) && /owner/.test(text(q('#who'))), 'header keeps only who you are, Help and Sign out');
    ok(vis(q('#viewOrders')) && !vis(q('#viewStock')) && !vis(q('#viewMore')), 'Orders is shown first');
    click(o.byText('#tabs .tab', /^Stock$/)); await sleep(300);
    ok(!vis(q('#viewOrders')) && vis(q('#viewStock')), 'the Stock tab swaps the page');
    click(o.byText('#tabs .tab', /^More$/)); await sleep(200);
    ok(vis(q('#viewMore')) && !vis(q('#viewStock')), 'the More tab swaps the page');
    click(o.byText('#tabs .tab', /^Orders$/)); await sleep(100);
    ok(vis(q('#viewOrders')), 'back to Orders');
    ok(o.errors.length === 0, 'no page errors in the shell (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff');
    ok(s.qa('#tabs .tab').filter(vis).map((t) => s.text(t)).join('|') === 'Orders|Stock', 'staff sees only Orders and Stock');
    s.close();
  });

  // Task 2: the Needs-you-now strip replaces the stacked bars
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    ok(!o.doc.getElementById('unpaidBar') && !o.doc.getElementById('lowBar'), 'the old unpaid and low-stock bars are gone');
    const cards = qa('#needs .need');
    ok(cards.length >= 2, 'the strip shows cards for what needs doing (' + cards.map((c) => text(c)).join(' | ') + ')');
    const step = (re) => o.byText('#flow .step', re);
    const topackCount = Number(text(step(/To pack/).querySelector('b')));
    const needPack = cards.find((c) => /to pack/.test(text(c)));
    ok(topackCount === 0 ? !needPack : (needPack && Number(text(needPack.querySelector('b'))) === topackCount), 'the to-pack card carries the same count as the step button');
    ok(cards.every((c) => Number(text(c.querySelector('b'))) > 0), 'a card appears only when its count is above zero');
    click(o.byText('#flow .step', /Delivered/)); await sleep(100);
    if (needPack) { click(qa('#needs .need').find((c) => /to pack/.test(text(c)))); await sleep(100); ok(/To pack/.test(text(q('#flow .step.on'))), 'tapping the card opens that step'); }
    const low = qa('#needs .need').find((c) => /low/i.test(text(c)));
    ok(!!low, 'a running-low card shows the flavours that are low');
    if (low) { click(low); await sleep(300); ok(!q('#viewStock').hidden, 'the running-low card opens the Stock tab'); }
    ok(/Today/.test(text(q('#todayLine'))) && !q('#todayLine').hidden, 'the owner sees one quiet line of today\'s money');
    ok(o.errors.length === 0, 'no page errors with the strip (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff');
    ok(s.q('#todayLine').hidden, 'staff do not see the money line');
    s.close();
  });

  return list;
};
