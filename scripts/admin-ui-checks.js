'use strict';
// Checks for the redesigned admin, one block per plan task. Each is an async function run by admin-ui-test.js.
module.exports = function checks({ openAdmin, ok, sleep, until, BASE }) {
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
    ok(!cards.some((c) => /packed order|shipped order/.test(text(c))) || topackCount === 0, 'the strip gives ONE do-this-next card and does not repeat every step button');
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

  // Task 3: filters live in a sheet
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, set } = o;
    ok(!q('details.more') && !!q('#filterBtn'), 'the "More filters" accordion is replaced by a Filter button');
    click(o.byText('#flow .step', /Delivered/)); await sleep(100);
    const amounts = () => qa('#list .card .top').map((t) => Number((text(t).match(/₹([\d,.]+)$/) || [0, '0'])[1].replace(/,/g, '')));
    click(q('#filterBtn')); await sleep(150);
    ok(q('#sheet.on') && q('#panel #sort') && q('#panel #csv') && q('#panel #reset'), 'the Filter button opens a sheet with sort, download and clear');
    set(q('#sort'), 'valueAsc'); await sleep(150);
    const a = amounts(); ok(a.length < 2 || a.every((v, i) => i === 0 || a[i - 1] <= v), 'sorting by lowest value reorders the list (' + a.join(',') + ')');
    click(o.byText('#panel button', /^Close$/)); await sleep(100); click(q('#filterBtn')); await sleep(150);
    ok(q('#sort').value === 'valueAsc', 'the choice is remembered when the sheet is reopened');
    ok(/•|on/.test(q('#filterBtn').className + text(q('#filterBtn'))), 'the Filter button shows a dot while a filter is active');
    click(q('#reset')); await sleep(150);
    ok(q('#sort').value === 'new' && /To pack/.test(text(q('#flow .step.on'))), 'Clear filters returns to the default view');
    click(o.byText('#panel button', /^Close$/)); await sleep(100); click(o.byText('#tabs .tab', /^More$/)); await sleep(100); click(o.byText('.morebtn', /Prices/)); await until(() => q('#sheet.on') && /Prices/i.test(text(q('#panel'))), 3000, 'the Prices sheet').catch(() => {});
    ok(!!q('#sheet.on') && /Prices/i.test(text(q('#panel'))), 'another sheet still opens normally after the filter sheet (the filter box is not lost)');
    ok(!!o.doc.getElementById('filterBox'), 'the filter box survives other sheets');
    ok(o.errors.length === 0, 'no page errors with the filter sheet (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Task 4: Stock is a page, not a popup
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    click(o.byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    ok(!q('#sheet.on'), 'Stock opens as a page, not a popup');
    ok(/Atta Kesari/.test(text(q('#viewStock'))) && /Atta Sugar-Lite/.test(text(q('#viewStock'))) && /Packing tape/.test(text(q('#viewStock'))), 'the page lists the flavours and the packaging');
    // Task 11 changed this check: the top button was Receive stock (a picker, then the old receive form); biscuits now arrive only through New delivery
    const top = o.byText('#viewStock button', /^New delivery$/);
    ok(!!top && !o.byText('#viewStock button', /^Receive stock$/), 'one New delivery button sits at the top (Receive stock is gone)');
    click(top); await until(() => qa('#viewStock .dlrow').length === 4, 4000, 'the New delivery page').catch(() => {});
    ok(/^New delivery/.test(text(q('#viewStock .pagehead'))) && /Atta Kesari/.test(text(q('#viewStock'))), 'it opens New delivery with a row per flavour');
    ok(!q('#sheet.on'), 'New delivery opens in the page');
    click(o.byText('#viewStock button', /^Back to Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 3000, 'back to the stock list');
    ok(true, 'Back returns to the stock list');
    click(o.byText('#viewStock button', /^History$/)); await until(() => /Stock history/.test(text(q('#viewStock'))), 4000, 'the history page').catch(() => {});
    ok(/Stock history/.test(text(q('#viewStock'))) && !q('#sheet.on'), 'History also opens in the page');
    ok(o.errors.length === 0, 'no page errors on the stock page (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff'); click(s.byText('#tabs .tab', /^Stock$/)); await until(() => s.qa('#viewStock .line').length >= 4, 4000, 'the stock page for staff');
    ok(!s.byText('#viewStock button', /^Add packaging item$/) && !s.byText('#viewStock button', /Low level/) && !s.byText('#viewStock button', /^Remove$/), 'staff do not see owner-only stock controls');
    s.close();
  });

  // Offline sales: hamper form and the flow report
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    click(o.byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    click(o.byText('#viewStock button', /Sold offline: hamper/)); await sleep(200);
    ok(/Hamper sold offline/.test(text(q('#viewStock'))) && /Which hamper/.test(text(q('#viewStock'))) && !/candle/i.test(text(q('#viewStock')).replace(/Bags, candles and paper are not counted here\./,'')), 'the hamper form asks which hamper, how many and the boxes opened (no supplies)');
    click(o.byText('#viewStock button', /Save hamper sale/)); await sleep(400);
    ok(!/Recorded/.test(text(q('#viewStock'))), 'an empty hamper sale is refused');
    click(o.byText('#viewStock button', /^Back$/)); await until(() => qa('#viewStock .line').length >= 4, 3000, 'back to stock');
    await until(() => o.byText('#viewStock button', /Where did it go/), 4000, 'the flow button'); click(o.byText('#viewStock button', /Where did it go/)); await until(() => /Where did the stock go/.test(text(q('#viewStock'))), 4000, 'the flow report').catch(() => {});
    ok(/Where did the stock go/.test(text(q('#viewStock'))) && /On the shelf/.test(text(q('#viewStock'))), 'the flow report lists where each item went');
    ok(o.errors.length === 0, 'no page errors on the hamper screens (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Take out several flavours in one entry; sold at an exhibition or event (26 Oct 2026)
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText, set } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const apiGet = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } })).json());
    const onHand = async (slug) => (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === slug).on_hand;
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    ok(!!byText('#viewStock button', /Take out: several/), 'the stock page has a Take out: several flavours button');
    click(byText('#viewStock button', /Take out: several/)); await until(() => /Take out: several flavours/.test(text(q('#viewStock'))), 4000, 'the multi take-out form');
    const sel = q('#viewStock select');
    ok(sel && Array.from(sel.options).some((op) => op.value === 'EVENT_SALE' && /Sold at an exhibition or event/.test(op.textContent)) && sel.value === 'EVENT_SALE', 'reasons include Sold at an exhibition or event, chosen first');
    const boxes = qa('#viewStock input[data-slug]');
    ok(['atta-original', 'atta-ajwain', 'atta-kesari', 'atta-lite-sugar'].every((sl) => boxes.some((b) => b.getAttribute('data-slug') === sl)), 'one box per flavour (' + boxes.map((b) => b.getAttribute('data-slug')).join(',') + ')');
    ok(/Which event/.test(text(q('#viewStock'))), 'it asks which event');
    const k0 = await onHand('atta-kesari'), o0 = await onHand('atta-original');
    click(byText('#viewStock button', /^Save take-out$/)); await sleep(400);
    ok(await onHand('atta-kesari') === k0, 'saving with nothing filled is refused and changes nothing');
    set(q('#viewStock input[data-role="who"]'), 'Diwali Fair, Sector 15');
    set(boxes.find((b) => b.getAttribute('data-slug') === 'atta-kesari'), '3');
    set(boxes.find((b) => b.getAttribute('data-slug') === 'atta-original'), '2');
    click(byText('#viewStock button', /^Save take-out$/));
    await until(async () => (await onHand('atta-kesari')) === k0 - 3, 5000, 'stock to drop').catch(() => {});
    ok(await onHand('atta-kesari') === k0 - 3 && await onHand('atta-original') === o0 - 2, 'one save takes 3 Kesari and 2 Original off stock');
    const hist = await apiGet('/admin/api/inventory/history?types=EVENT_SALE&limit=10');
    ok(hist.movements && hist.movements.length >= 2 && hist.movements.every((m) => m.type === 'EVENT_SALE' && m.ref === 'Diwali Fair, Sector 15'), 'the lines are event sales with the event name');
    // the single take-out and the reports know the new reason
    await until(() => qa('#viewStock .line').length >= 4, 4000, 'back at the stock list').catch(() => {});
    click(byText('#viewStock button', /Where did it go/)); await until(() => /Where did the stock go/.test(text(q('#viewStock'))), 4000, 'the flow report').catch(() => {});
    ok(/Sold at events/.test(text(q('#viewStock'))), 'Where did it go shows Sold at events');
    click(byText('#viewStock button', /^Back$/)); await until(() => qa('#viewStock .line').length >= 4, 3000, 'back');
    click(byText('#viewStock button', /^History$/)); await until(() => /Stock history/.test(text(q('#viewStock'))), 4000, 'history');
    ok(qa('#viewStock .line').some((l) => /Sold at event/.test(text(l)) && /Diwali Fair, Sector 15/.test(text(l))), 'history labels the lines Sold at event, with the event');
    ok(o.errors.length === 0, 'no page errors on the multi take-out (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Delivery dates and LATE orders; per-flavour Take out removed from the stock page (27 Oct 2026)
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText } = o;
    const card = (id) => qa('#list .card').find((c) => text(c).includes(id));
    click(byText('#flow .step', /Shipped/)); await until(() => !!card('MNG-WITH-1009'), 4000, 'the shipped list');
    const late = card('MNG-WITH-1009'), waiting = card('MNG-CCCC-1009');
    ok(late && /LATE/.test(text(late)) && /2 days late/.test(text(late)), 'an order past Delhivery\'s promised date shows LATE and how many days (' + (late ? text(late).slice(0, 160) : 'no card') + ')');
    ok(late && /Expected by/.test(text(late)), 'the card shows the expected delivery date');
    ok(late && late.classList.contains('late'), 'the late card is marked out (red edge)');
    ok(waiting && !/LATE/.test(text(waiting)), 'a parcel Delhivery has not collected yet is not LATE');
    ok(qa('#needs .need').some((b) => /1\s*late order/i.test(text(b)) && b.classList.contains('hot')), 'the top bar says 1 late order, in red');
    const chip = qa('#chips .chip').find((c) => /^Late \d+/.test(text(c)));
    ok(chip && /^Late 1$/.test(text(chip)), 'a Late filter tab with the count (' + qa('#chips .chip').map((c) => text(c)).join(' | ') + ')');
    click(chip); await sleep(150);
    ok(qa('#list .card').length === 1 && !!card('MNG-WITH-1009'), 'the Late tab lists only late orders');
    click(late || card('MNG-WITH-1009')); await until(() => /Expected delivery/.test(text(q('#sheet'))), 4000, 'the order sheet').catch(() => {});
    ok(/Expected delivery/.test(text(q('#sheet'))) && /LATE/.test(text(q('#sheet'))), 'the order sheet shows the expected delivery date and LATE');
    o.close();

    // stock page: no per-flavour Take out; packaging is hand-kept (Set count only, no Receive or Take out); the several-flavours form title reads right
    const s = await openAdmin('owner');
    click(s.byText('#tabs .tab', /^Stock$/)); await until(() => s.qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    const rows = s.qa('#viewStock .line');
    const btns = (re) => rows.filter((l) => re.test(s.text(l))).map((l) => Array.from(l.querySelectorAll('button')).map((b) => s.text(b)));
    const kes = btns(/Atta Kesari/)[0] || [], tape = btns(/Packing tape/)[0] || [];
    ok(kes.length && !kes.includes('Take out') && kes.includes('Count') && kes.includes('Receive'), 'a flavour has no Take out of its own any more (' + kes.join(',') + ')');
    ok(tape.includes('Set count') && !tape.includes('Take out') && !tape.includes('Receive'), 'packaging (tape) offers Set count, and no Receive or Take out (' + tape.join(',') + ')');
    s.click(s.byText('#viewStock button', /Take out: several/)); await until(() => /Take out/.test(s.text(s.q('#viewStock'))), 4000, 'the form');
    ok(/Take out: several flavours/.test(s.text(s.q('#viewStock'))) && !/Take out several: flavours/.test(s.text(s.q('#viewStock'))), 'the form title reads Take out: several flavours');
    ok(o.errors.length === 0 && s.errors.length === 0, 'no page errors (' + o.errors.concat(s.errors).join(' | ').slice(0, 200) + ')');
    s.close();
  });

  // Suggestions from WhatsApp: More > Suggestions lists them; the owner marks Planned / Done / Not for us (28 Oct 2026)
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText } = o;
    click(byText('#tabs .tab', /^More$/)); await until(() => !!byText('#viewMore .morebtn', /Suggestions/), 4000, 'the More page');
    click(byText('#viewMore .morebtn', /Suggestions/)); await until(() => /jaggery/i.test(text(q('#panel'))), 4000, 'the suggestions list').catch(() => {});
    const p = text(q('#panel'));
    ok(/Make a jaggery one/.test(p) && /Riya Kapoor/.test(p) && /MNG-SUGG-2810/.test(p), 'a suggestion shows its text, who sent it and their latest order');
    ok(/Feedback/.test(p) && /4/.test(p) && /Kesari too sweet/.test(p), 'feedback form answers are listed too, with the rating');
    ok(/taste it first, free/i.test(p), 'the screen reminds the owner of the promise');
    const row = qa('#panel .line').find((l) => /jaggery/i.test(text(l)));
    const done = row && Array.from(row.querySelectorAll('button')).find((b) => /^Done$/.test(text(b)));
    ok(!!done, 'each suggestion has Planned / Done / Not for us');
    click(done); await until(() => qa('#panel .line').some((l) => /jaggery/i.test(text(l)) && /DONE/.test(text(l))), 4000, 'the status to change').catch(() => {});
    ok(qa('#panel .line').some((l) => /jaggery/i.test(text(l)) && /DONE/.test(text(l))), 'marking Done shows DONE (promise to keep: they taste it first)');
    ok(o.errors.length === 0, 'no page errors on Suggestions (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff');
    click(s.byText('#tabs .tab', /^Orders$/)); await sleep(100);
    ok(!s.byText('#tabs .tab', /^More$/) || s.q('#moreTab').hidden, 'staff cannot open More (Suggestions stays with the owner)');
    s.close();
  });

  // Refunded is its own tab, apart from Cancelled
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    const chips = qa('#chips .chip').map((c) => text(c));
    ok(chips.some((t) => /^Cancelled \d+/.test(t)) && chips.some((t) => /^Refunded \d+/.test(t)), 'Cancelled and Refunded are separate filter tabs (' + chips.join(' | ') + ')');
    click(o.byText('#chips .chip', /^Refunded/)); await sleep(150);
    ok(qa('#list .card').some((c) => /MNG-EEEE-1008/.test(text(c)) && /REFUNDED/.test(text(c))), 'a refunded order sits under Refunded with a REFUNDED badge');
    ok(/refunded/.test(text(q('#count'))), 'the Refunded tab totals the money refunded');
    click(o.byText('#chips .chip', /^Cancelled/)); await sleep(150);
    ok(!qa('#list .card').some((c) => /MNG-EEEE-1008/.test(text(c))), 'a refunded order is not listed under Cancelled');
    ok(o.errors.length === 0, 'no page errors on the refunded tab');
    o.close();
  });

  // Task 5: plain words
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    for (const re of [/To pack/, /Packed/, /Shipped/, /Delivered/]) { click(o.byText('#flow .step', re)); await sleep(60); ok(!/AWB/.test(text(q('#hint'))) && text(q('#hint')).length > 10, 'the hint under ' + re + ' is a plain sentence'); }
    click(o.byText('#flow .step', /Packed/)); await sleep(100);
    const btn = o.byText('#list .card button', /Create shipment/);
    ok(!!btn && !o.byText('#list .card button', /Ship \/ hand over/), 'a packed order\'s button reads Create shipment');
    click(q('#list .card')); await until(() => q('#sheet.on'), 3000, 'the order'); await sleep(200);
    ok(/Tracking number \(AWB\)/.test(text(q('#panel'))), 'the manual form says Tracking number (AWB)');
    ok(/Create Delhivery shipment/.test(text(q('#panel'))), 'the one-tap shipment button is on the order');
    o.close();
  });

  // Task 6: bulk create shipments and bulk mark delivered
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    let prompts = 0; o.win.prompt = (m, d) => { prompts++; return d == null ? '' : String(d); };
    const markPacked = async (idRe) => { click(o.byText('#flow .step', /To pack/)); await sleep(80); const c = qa('#list .card').find((x) => idRe.test(text(x))); if (c) { click(Array.from(c.querySelectorAll('button')).find((b) => /Mark packed/.test(text(b)))); await sleep(400); } };
    await markPacked(/MNG-GGGG-1010/);
    click(o.byText('#flow .step', /^STEP 2/)); await sleep(100);
    const packedIds = qa('#list .card').map((c) => text(c).match(/MNG-[A-Z0-9]+-\d+/)[0]);
    ok(packedIds.length >= 3 && packedIds.includes('MNG-GGGG-1010'), 'there are packed orders to ship (' + packedIds.join(',') + ')');
    click(o.byText('#bulk .chip', /Select all/)); await sleep(100);
    const shipBtn = o.byText('#bulk button', /Create Delhivery shipments/);
    ok(!!shipBtn && new RegExp('\\(' + packedIds.length + '\\)').test(text(shipBtn)), 'the Packed step offers Create Delhivery shipments for all ticked orders (' + (shipBtn ? text(shipBtn) : 'missing') + ')');
    click(shipBtn); await until(() => /Finished:/.test(text(q('#panel'))), 8000, 'the shipments to finish');
    const panel = text(q('#panel'));
    ok((panel.match(/Created/g) || []).length === packedIds.length - 1, 'every order except the failing one was created (' + panel.slice(0, 300) + ')');
    ok(/MNG-GGGG-1010Not created:[^]*?not serviceable/i.test(panel), 'the failing order shows a red line with Delhivery\'s reason and does not stop the others (' + panel.slice(0, 500) + ')');
    ok(prompts === 0, 'bulk shipping asks no weight question (each parcel uses its own estimate)');
    click(o.byText('#panel button', /Go to Shipped/)); await sleep(200);
    ok(/Shipped/.test(text(q('#flow .step.on'))) && qa('#list .card').length >= packedIds.length - 1, 'the created orders are now under Shipped');
    click(o.byText('#bulk .chip', /Select all/)); await sleep(100);
    const del = o.byText('#bulk button', /Mark delivered/); ok(!!del, 'the Shipped step offers Mark delivered for all ticked orders');
    const before = Number(text(o.byText('#flow .step', /Delivered/).querySelector('b')));
    click(del); await until(() => /Finished:/.test(text(q('#panel'))), 8000, 'delivery to finish');
    click(o.byText('#panel button', /Close/)); await until(() => Number(text(o.byText('#flow .step', /Delivered/).querySelector('b'))) > before, 4000, 'the delivered count').catch(() => {});
    ok(Number(text(o.byText('#flow .step', /Delivered/).querySelector('b'))) > before, 'ticked shipped orders moved to Delivered');
    ok(o.errors.length === 0, 'no page errors with bulk actions (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Sorting has both directions everywhere
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, set } = o;
    click(o.byText('#flow .step', /Delivered/)); await sleep(100);
    const opts = qa('#sort option').map((x) => x.value).sort().join(',');
    ok(opts === 'boxesAsc,boxesDesc,nameAZ,nameZA,new,old,valueAsc,valueDesc', 'every sort has both directions (' + opts + ')');
    const ids = () => qa('#list .card').map((c) => text(c).match(/MNG-[A-Z0-9]+-\d+/)[0]);
    const boxes = () => qa('#list .card .meta:first-of-type').map((m) => Number((text(m).match(/(\d+) boxes?/) || [0, 0])[1]));
    set(q('#sort'), 'boxesAsc'); await sleep(100); let b = boxes(); ok(b.every((v, i) => i === 0 || b[i - 1] <= v), 'fewest boxes first (' + b + ')');
    set(q('#sort'), 'boxesDesc'); await sleep(100); b = boxes(); ok(b.every((v, i) => i === 0 || b[i - 1] >= v), 'most boxes first (' + b + ')');
    set(q('#sort'), 'nameZA'); await sleep(100); const za = ids(); set(q('#sort'), 'nameAZ'); await sleep(100); ok(JSON.stringify(za) === JSON.stringify(ids().reverse()), 'name Z to A is the exact reverse of A to Z');
    const flip = q('#sortFlip'); ok(!!flip && /Name A to Z/.test(text(flip)), 'a visible button shows the current sort (' + (flip ? text(flip) : 'missing') + ')');
    click(flip); await sleep(100); ok(q('#sort').value === 'nameZA' && /Name Z to A/.test(text(q('#sortFlip'))), 'tapping it flips the direction');
    set(q('#sort'), 'new'); await sleep(100); const newest = ids(); click(q('#sortFlip')); await sleep(100); ok(q('#sort').value === 'old' && JSON.stringify(ids()) === JSON.stringify(newest.slice().reverse()), 'newest and oldest are exact reverses');
    ok(o.errors.length === 0, 'no page errors while sorting (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Task 7: first-time guide, Help, accessibility
  list.push(async () => {
    const o = await openAdmin('owner', { guide: true }); const { q, qa, text, click } = o;
    const g = q('#guide'); ok(!!g && !g.hidden, 'a first-time visitor sees the guide');
    ok(qa('#guide li').length === 4 && /Pack/.test(text(g)) && /shipment/i.test(text(g)) && /label/i.test(text(g)) && /delivered/i.test(text(g)), 'the guide has the four steps in plain words');
    click(o.byText('#guide button', /Got it/)); await sleep(100);
    ok(q('#guide').hidden && o.win.localStorage.getItem('mngGuideSeen') === '1', 'Got it hides it and remembers that on this device');
    click(q('#helpBtn')); await sleep(150);
    ok(!!q('#sheet.on') && /How this works/.test(text(q('#panel'))) && qa('#panel li').length === 4, 'the ? button reopens the four steps as Help');
    click(o.byText('#panel button', /^Close$/)); await sleep(60);
    // accessibility
    const unnamed = qa('button').filter((b) => !text(b) && !b.getAttribute('aria-label') && !b.getAttribute('title'));
    ok(unnamed.length === 0, 'every button has a name (' + unnamed.map((b) => b.id || b.className).join(',') + ')');
    ok(q('#tabs').getAttribute('role') === 'tablist' && qa('#tabs .tab').every((t) => t.getAttribute('role') === 'tab' && /true|false/.test(t.getAttribute('aria-selected'))), 'tabs are announced as tabs with a selected state');
    click(o.byText('#tabs .tab', /^Stock$/)); await sleep(300); ok(o.byText('#tabs .tab', /^Stock$/).getAttribute('aria-selected') === 'true', 'the selected tab is marked');
    ok(!!q('#q').getAttribute('aria-label'), 'the search box has an accessible name');
    ok(o.errors.length === 0, 'no page errors with the guide and help (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const seen = await openAdmin('owner'); ok(seen.q('#guide').hidden, 'someone who has seen it does not get it again'); seen.close();
  });

  // Every button style combination the page uses must set its own text AND background colours (a ghost button with a red
  // background once showed terracotta text on red: Pause selling).
  list.push(async () => {
    const html = await (await fetch(BASE + '/admin')).text();
    const used = new Set(); for (const m of html.matchAll(/class: '(btn[^']*)'/g)) used.add(m[1].trim().split(/\s+/).filter((c) => !['small'].includes(c)).sort().join(' '));
    for (const m of html.matchAll(/class: '(btn ghost small)' \+ \([^)]*'\s?(red)'/g)) used.add('btn ghost red');
    ok(used.has('btn ghost red'), 'the page really uses the ghost + red combination (Pause selling, Clear low flag)');
    const rule = (html.match(/\.btn\.ghost\.red\{[^}]*\}/) || [''])[0];
    ok(/background:transparent/.test(rule) && /color:var\(--tx-red\)/.test(rule) && /border[^;]*var\(--red\)/.test(rule), 'a ghost red button is outlined with red text on a clear background (' + rule + ')');
    ok(/\.btn\.red\{[^}]*background:var\(--red\)/.test(html) && !/\.btn\.red\{[^}]*color:var\(--tx-terra\)/.test(html), 'a filled red button keeps white text');
  });

  // Contrast: text and button colours meet WCAG AA (4.5:1) in the light and dark palettes
  list.push(async () => {
    const html = await (await fetch(BASE + '/admin')).text();
    const root = (re) => Object.fromEntries([...(html.match(re) || [''])[0].matchAll(/--([a-z0-9-]+):(#[0-9A-Fa-f]{3,6})/g)].map((m) => [m[1], m[2]]));
    const light = root(/:root\{[^}]*\}/); const darkOver = root(/prefers-color-scheme:dark\)\{:root\{[^}]*\}/); const dark = { ...light, ...darkOver };
    const lum = (hex) => { let h = hex.slice(1); if (h.length === 3) h = h.replace(/./g, '$&$&'); const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const pairs = (t) => [['ink on paper', t.ink, t.paper], ['ink2 on paper', t.ink2, t.paper], ['ink on cream', t.ink, t.cream], ['ink2 on cream', t.ink2, t.cream], ['white on terracotta button', '#FFFFFF', t['terra']], ['white on green button', '#FFFFFF', t.green], ['white on red button', '#FFFFFF', t.red], ['terracotta text on paper', t['tx-terra'], t.paper], ['amber note on cream', t['tx-amber'], t.cream], ['red text on paper', t['tx-red'], t.paper], ['green text on paper', t['tx-green'], t.paper], ['terracotta text on cream', t['tx-terra'], t.cream], ['badge: amber on pale amber', t.amber, '#FDF0D5'], ['badge: green on pale green', t.green, '#DDEFE3'], ['badge: red on pale red', t.red, '#F6DAD8'], ['badge: navy on pale blue', t.navy, '#E3ECF6'], ['badge: purple on pale purple', '#5A3E99', '#E8E1F4'], ['white on navy', '#FFFFFF', t.navy], ['white on delivered green', '#FFFFFF', t.green]];
    for (const [name, theme] of [['light', light], ['dark', dark]]) for (const [label, fg, bg] of pairs(theme)) { if (!fg || !bg) continue; const r = ratio(fg, bg); ok(r >= 4.5, name + ': ' + label + ' is ' + r.toFixed(2) + ':1 (needs 4.5)'); }
  });

  // Pick-list footer: says what the list covers and what it left out
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click } = o;
    let page = ''; o.win.open = () => ({ document: { open() {}, write(h) { page += h; }, close() {} }, focus() {}, print() {}, close() {} });
    click(o.byText('#flow .step', /To pack/)); await sleep(100);
    const toPack = qa('#list .card').map((c) => text(c).match(/MNG-[A-Z0-9]+-\d+/)[0]);
    click(o.byText('#bulk button', /Print pick list/)); await until(() => /What this list covers/.test(page), 4000, 'the pick list');
    const covers = (page.match(/What this list covers[\s\S]*?Left out/) || [''])[0];
    ok(toPack.length > 0 && toPack.every((id) => covers.includes(id)), 'the footer names every order the list covers (' + toPack.join(',') + ')');
    ok(new RegExp('<b>' + toPack.length + ' order').test(covers), 'and says how many there are');
    const left = (page.match(/Left out of this list[\s\S]*$/) || [''])[0];
    ok(/MNG-TEST-1001/.test(left) && /test order/i.test(left), 'a test order is named under left out, with the reason');
    ok(/MNG-UUUU-1011/.test(left) && /waiting for payment/.test(left), 'unpaid orders are named too');
    ok(/already shipped/.test(left) || /already delivered/.test(left), 'shipped and delivered orders are counted');
    ok(!toPack.some((id) => left.includes(id)), 'a covered order is never listed as left out');
    ok(/count only the orders listed/i.test(page), 'a plain-words note explains what the box totals include');
    ok(o.errors.length === 0, 'no page errors printing the pick list (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Shipped tab is split: "Awaiting pickup" (booked, courier has not collected) above "With courier".
  // Runs FIRST: later checks mark the practice parcels delivered, which would empty the Shipped step.
  list.unshift(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, set } = o;
    click(o.byText('#flow .step', /Shipped/)); await sleep(150);
    const shippedCount = Number(text(o.byText('#flow .step', /Shipped/).querySelector('b')));
    const heads = qa('#list .sechead').map((h) => text(h));
    ok(heads.length === 2 && /^Awaiting pickup/.test(heads[0]) && /^With courier/.test(heads[1]), 'Shipped shows Awaiting pickup above With courier (saw: ' + heads.join(' | ') + ')');
    const section = {}; let cur = '';
    Array.from(q('#list').children).forEach((k) => { if (k.classList.contains('sechead')) cur = text(k); else if (k.classList.contains('card')) section[(text(k).match(/MNG-[A-Z0-9]+-\d+/) || [''])[0]] = cur; });
    ok(/^Awaiting pickup/.test(section['MNG-CCCC-1009'] || ''), 'a booked Delhivery parcel sits under Awaiting pickup');
    ok(/^With courier/.test(section['MNG-WITH-1009'] || ''), 'a parcel the courier has collected sits under With courier');
    ok(qa('#list .card').length === shippedCount, 'section headers are not cards: the card count still equals the Shipped step count (' + qa('#list .card').length + ' vs ' + shippedCount + ')');
    ok(/Awaiting pickup/.test(text(q('#list .sechead'))) && /\b1\b/.test(heads[0]), 'the header carries how many parcels wait (saw: ' + heads[0] + ')');
    const cardOf = (id) => qa('#list .card').find((c) => text(c).includes(id));
    ok(!/Mark delivered/.test(text(cardOf('MNG-CCCC-1009'))), 'a parcel awaiting pickup has no one-tap Mark delivered (it has not even been collected)');
    ok(/Mark delivered/.test(text(cardOf('MNG-WITH-1009'))), 'a parcel with the courier keeps its one-tap Mark delivered');
    set(q('#q'), 'WITH-1009'); await sleep(120);
    ok(qa('#list .sechead').length === 1 && /^With courier/.test(text(q('#list .sechead'))), 'a section with nothing in it shows no header');
    set(q('#q'), '');
    click(o.byText('#flow .step', /Packed/)); await sleep(120);
    ok(qa('#list .sechead').length === 0, 'other steps have no pick-up sections');
    ok(o.errors.length === 0, 'no page errors on the Shipped split (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Day headers: orders from different days are visibly separated when the list is in date order
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, set } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const api = await (await fetch(BASE + '/admin/api/orders', { headers: { Authorization: 'Bearer ' + token } })).json();
    const istDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const label = (iso) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
    const dayOf = Object.fromEntries(api.orders.map((x) => [x.id, { day: istDay(x.paid_at || x.created_at), label: label(x.paid_at || x.created_at) }]));
    click(o.byText('#chips .chip', /^All\b/)); await sleep(150);
    for (const sort of ['new', 'old']) {
      set(q('#sort'), sort); await sleep(150);
      const kids = Array.from(q('#list').children);
      let prev = null, headNow = null, good = true, why = '', heads = 0;
      kids.forEach((k) => {
        if (k.classList.contains('dayhead')) { heads++; headNow = k; return; }
        if (!k.classList.contains('card')) return;
        const id = (text(k).match(/MNG-[A-Z0-9]+-\d+/) || [''])[0]; const d = dayOf[id];
        if (!d) return;
        if (!prev || prev !== d.day) { if (!headNow || !text(headNow).includes(d.label)) { good = false; why = id + ' should follow a header with ' + d.label + ' (saw ' + (headNow ? text(headNow) : 'none') + ')'; } }
        else if (headNow) { good = false; why = id + ' is the same day as the card above, so no header should sit between them'; }
        prev = d.day; headNow = null;
      });
      const days = new Set(Array.from(q('#list').querySelectorAll('.card')).map((c) => (dayOf[(text(c).match(/MNG-[A-Z0-9]+-\d+/) || [''])[0]] || {}).day));
      ok(good, 'sort ' + sort + ': exactly one header at the start of each new day (' + why + ')');
      ok(heads === days.size && heads >= 3, 'sort ' + sort + ': one header per day (' + heads + ' headers, ' + days.size + ' days)');
    }
    set(q('#sort'), 'new'); await sleep(120);
    const under = {}; let hd = '';
    Array.from(q('#list').children).forEach((k) => { if (k.classList.contains('dayhead')) hd = text(k); else if (k.classList.contains('card')) under[(text(k).match(/MNG-[A-Z0-9]+-\d+/) || [''])[0]] = hd; });
    ok(/20 Oct/.test(under['MNG-ISTA-1000'] || '') && /21 Oct/.test(under['MNG-ISTB-1000'] || ''), 'days are Indian days: 22:30 IST on 20 Oct and 00:30 IST on 21 Oct are different days (saw: ' + under['MNG-ISTA-1000'] + ' / ' + under['MNG-ISTB-1000'] + ')');
    const first = text(q('#list .dayhead')); ok(/\b\d+ orders?\b/.test(first) && /\b\d+ boxes?\b/.test(first), 'a header says how many orders and boxes that day (saw: ' + first + ')');
    for (const sort of ['valueAsc', 'boxesDesc', 'nameAZ']) { set(q('#sort'), sort); await sleep(120); ok(qa('#list .dayhead').length === 0, 'sort ' + sort + ': no day headers (they only make sense in date order)'); }
    set(q('#sort'), 'new'); await sleep(120);
    set(q('#q'), 'ISTB'); await sleep(120);
    ok(qa('#list .dayhead').length === 1 && qa('#list .card').length === 1, 'a search that leaves one order shows one header');
    ok(o.errors.length === 0, 'no page errors with day headers (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Dates on New delivery: picked on a calendar; the code, best before, last ship and website stop are worked out, never typed (spec 6.2).
  // Task 11 changed this check: it was the old Receive form (prepared-on picker that filled 15OCT26 and a best before to edit by hand),
  // which a biscuit's Receive no longer opens.
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText, set } = o;
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock list');
    const orig = qa('#viewStock .line').find((l) => /Atta Original/.test(text(l)));
    click(Array.from(orig.querySelectorAll('button')).find((b) => /^Receive$/.test(text(b))));
    await until(() => qa('#viewStock .dlrow').length === 4, 4000, 'New delivery from Receive');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const arrived = q('#dl-arrivedOn'), bake = q('#dl-bakeDate');
    ok(!!arrived && !!bake && arrived.type === 'date' && bake.type === 'date', 'arrived on and the bake date are calendar pickers');
    ok(arrived.value === today && arrived.max === today && bake.max === today, 'arrived on starts at today; neither can be after today (' + [arrived.value, arrived.max, bake.max].join(' / ') + ')');
    ok(bake.value === '', 'the bake date has no default: it must be entered');
    ok(/Bake date \(from the bill\)/.test(text(q('#viewStock'))), 'the bake date is labelled "Bake date (from the bill)"');
    const labels = qa('#viewStock label').map((l) => text(l)).join(' | ');
    ok(!/best before|lot code/i.test(labels) && !qa('#viewStock input').some((i) => /lot code/i.test(i.placeholder || '')), 'no lot code or best-before field to type (' + labels.slice(0, 160) + ')');
    set(bake, '2026-10-15');
    ok(bake.value === '2026-10-15', 'a bake date can be picked');
    ok(o.errors.length === 0, 'no page errors on the New delivery dates (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Stock history: filter chips (receipts were buried under packed-order lines), and Correct on a receipt
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText, set } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const apiGet = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } })).json());
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock list');
    click(byText('#viewStock button', /^History$/)); await until(() => /Stock history/.test(text(q('#viewStock'))), 4000, 'the history page');
    const chips = qa('#viewStock .chip').map((c) => text(c));
    ok(['All', 'Received', 'Taken out', 'Sales'].every((c) => chips.includes(c)), 'History has filter chips All, Received, Taken out, Sales (saw: ' + chips.join('|') + ')');
    click(byText('#viewStock .chip', /^Received$/)); await until(() => qa('#viewStock .line').length >= 2 && qa('#viewStock .line').every((l) => /Received/.test(text(l))), 4000, 'only received lines');
    let lines = qa('#viewStock .line');
    ok(lines.length >= 2 && lines.every((l) => /Received/.test(text(l))), 'the Received chip lists only receipts (' + lines.length + ' lines)');
    const btn = (l, re) => Array.from(l.querySelectorAll('button')).find((b) => re.test(text(b)));
    ok(lines.every((l) => !!btn(l, /^Correct$/)), 'every receipt has a Correct button');
    ok(!!byText('#viewStock .chip.on', /^Received$/), 'the chosen chip is shown as selected');

    // Correct the Sugar-Lite receipt (33 received, 3 damaged) to 36 received, 0 damaged
    const before = (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').on_hand;
    click(btn(lines.find((l) => /atta-lite-sugar/.test(text(l))), /^Correct$/));
    await until(() => /Correct receipt: Atta Sugar-Lite/.test(text(q('#viewStock'))), 4000, 'the correct form');
    const inputs = qa('#viewStock input');
    ok(inputs[0].value === '33' && inputs[1].value === '3' && inputs.some((i) => i.value === '15OCT26'), 'the form is filled with the old receipt: 33 received, 3 damaged, lot 15OCT26 (saw ' + inputs.map((i) => i.value).join('/') + ')');
    const dates = qa('#viewStock input[type=date]');
    // the practice admin seeds best before relative to its start time (so it never ages past a cut-off), so read the seeded date back; the prepared date comes from the lot code 15OCT26
    const seededBB = ((await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').lots.find((l) => l.lot_code === '15OCT26') || {}).best_before;
    ok(dates.length === 2 && !!seededBB && dates[0].value === '2026-10-15' && dates[1].value === seededBB, 'the dates are calendar pickers, refilled from the old receipt: prepared 2026-10-15 (from the lot code), best before ' + seededBB + ' (the practice stock\'s seeded date) (saw ' + dates.map((d) => d.value).join(' / ') + ')');
    ok(inputs.some((i) => i.value === '15OCT26'), 'correcting without touching the date keeps the old lot code exactly');
    ok(inputs.some((i) => i.value === '3 crushed'), 'the old note is carried over');
    ok((await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').on_hand === before, 'opening Correct changes nothing yet');
    set(inputs[0], '36'); set(inputs[1], '0');
    click(byText('#viewStock button', /^Save receipt$/));
    // the practice data has packed orders already taken off Sugar-Lite, so check the change, not an absolute number: +33 -3 becomes +36 -0, a net +6
    await until(async () => (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').on_hand === before + 6, 5000, 'stock to update').catch(() => {});
    ok((await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').on_hand === before + 6, 'saving the correction adds the difference, +6 (was ' + before + ')');
    await until(() => qa('#viewStock .line').length >= 4, 4000, 'back at the stock list');

    click(byText('#viewStock button', /^History$/)); await until(() => /Stock history/.test(text(q('#viewStock'))), 4000, 'history again');
    // Wait for the history to redraw for the chosen chip (it reloads from the server), not a fixed time: a 300 ms sleep
    // read the previous view on a slow run, and the late redraw then hit the closed window (flaky until 29 Oct 2026).
    const shown = (chip, linesOk) => until(() => !!byText('#viewStock .chip.on', chip) && linesOk(qa('#viewStock .line')), 5000, 'the history to show ' + chip);
    click(byText('#viewStock .chip', /^Received$/)); await shown(/^Received$/, (ls) => ls.length >= 2 && ls.every((l) => /Received/.test(text(l)))).catch(() => {});
    lines = qa('#viewStock .line').filter((l) => /atta-lite-sugar/.test(text(l)));
    const oldLine = lines.find((l) => /\+33/.test(text(l))), newLine = lines.find((l) => /\+36/.test(text(l)));
    ok(!!oldLine && /Cancelled/.test(text(oldLine)) && !btn(oldLine, /^(Correct|Reverse)$/), 'the old receipt now says Cancelled and offers no Correct or Reverse (' + (oldLine ? text(oldLine).slice(0, 80) : 'missing') + ')');
    ok(!!newLine && !!btn(newLine, /^Correct$/), 'the new receipt is there, and can itself be corrected');
    click(byText('#viewStock .chip', /^All$/)); await shown(/^All$/, (ls) => ls.some((l) => !/Received/.test(text(l)))).catch(() => {});
    ok(qa('#viewStock .line').some((l) => /Reversed/.test(text(l))), 'the All view shows the reversing lines too');
    ok(o.errors.length === 0, 'no page errors on stock history (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
  });

  // Rename a lot (owner only): fixes a mistyped lot code without a phantom negative lot
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText, set } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const apiGet = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } })).json());
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock list');
    ok(!!byText('#viewStock button', /^Rename lot$/), 'the owner sees a Rename lot button');
    const before = (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar');
    click(byText('#viewStock button', /^Rename lot$/)); await until(() => /Which/i.test(text(q('#viewStock'))), 3000, 'the item picker');
    click(byText('#viewStock button', /Atta Sugar-Lite/)); await until(() => /Rename lot: Atta Sugar-Lite/.test(text(q('#viewStock'))), 3000, 'the rename form');
    const sel = q('#viewStock select');
    ok(!!sel && Array.from(sel.options).some((x) => /15OCT26/.test(x.textContent)), 'the form lists the product\'s current lots (' + (sel ? Array.from(sel.options).map((x) => x.textContent).join(' | ') : 'no select') + ')');
    set(qa('#viewStock input').find((i) => /15OCT26/.test(i.placeholder)), '16OCT26');
    click(byText('#viewStock button', /^Rename lot$/)); await until(async () => (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar').lots.some((l) => l.lot_code === '16OCT26'), 5000, 'the lot to be renamed').catch(() => {});
    const after = (await apiGet('/admin/api/inventory')).items.find((i) => i.slug === 'atta-lite-sugar');
    ok(after.lots.length === before.lots.length && after.lots.every((l) => l.lot_code !== '15OCT26') && after.lots.some((l) => l.lot_code === '16OCT26'), 'the lot now carries the new code and the old one is gone from the stock list (' + after.lots.map((l) => l.lot_code + ':' + l.qty).join(',') + ')');
    ok(after.on_hand === before.on_hand, 'total on hand is unchanged (' + before.on_hand + ' -> ' + after.on_hand + ')');
    ok(o.errors.length === 0, 'no page errors renaming a lot (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s = await openAdmin('staff'); click(s.byText('#tabs .tab', /^Stock$/)); await until(() => s.qa('#viewStock .line').length >= 4, 4000, 'the stock page for staff');
    ok(!s.byText('#viewStock button', /^Rename lot$/), 'staff do not see Rename lot');
    s.close();
  });

  // Reviews and Founding tasters (owner, More)
  list.push(async () => {
    const o = await openAdmin('owner'); const { q, qa, text, click, byText } = o;
    click(byText('#tabs .tab', /^More$/)); await sleep(200);
    ok(!!byText('#viewMore button', /Reviews/) && !!byText('#viewMore button', /Founding tasters/), 'More has Reviews and Founding tasters for the owner');
    click(byText('#viewMore button', /Reviews/)); await until(() => /Reviews/.test(text(q('#panel'))) && qa('#panel .rvcard').length >= 2, 4000, 'the reviews list');
    const cards = qa('#panel .rvcard');
    const bad = cards.find((c) => /REVB-1002/.test(text(c)));
    ok(!!bad && !bad.querySelector('img') && /<img src=x onerror=alert\(1\)>/.test(text(bad)), 'a comment with HTML shows as plain text; nothing is injected');
    ok(/Atta Original/.test(text(bad)) && /★/.test(text(bad)) && /NEW/i.test(text(bad)), 'a 1-star review shows its stars and is not hidden');
    ok(/Founding taster: gets new products free/.test(text(bad)), 'the founding taster label');
    ok(cards.some((c) => /Friend or family/.test(text(c))), 'the friend or family label');
    ok(/asked/i.test(text(q('#panel'))) && /received/i.test(text(q('#panel'))), 'the totals line');
    click(byText('#panel button', /^Close$/)); await sleep(100);
    click(byText('#viewMore button', /Founding tasters/)); await until(() => /Founding tasters/.test(text(q('#panel'))) && qa('#panel input[type=checkbox]').length >= 1, 4000, 'the tasters list');
    const rowsT = qa('#panel label.sw');
    const saved = rowsT.find((l) => /REVB-1002/.test(text(l)));
    ok(!!saved && saved.querySelector('input').checked, 'a buyer already on the saved list is ticked');
    ok(rowsT.filter((l) => !/REVB-1002/.test(text(l))).every((l) => !l.querySelector('input').checked), 'after the first save, other 11-17 Oct buyers are listed unticked (nobody is added silently)');
    ok(o.errors.length === 0, 'no page errors on reviews and tasters (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    const s2 = await openAdmin('staff');
    ok(!s2.byText('#tabs .tab', /^More$/) || !s2.byText('#viewMore button', /Reviews/), 'staff do not see Reviews');
    s2.close();
  });

  // Meta and Google on the Stock screen (channel sync): a line each, owner-only buttons, a problem in Needs you now. Phone width 375 px.
  list.push(async () => {
    const dev = async (b) => (await fetch(BASE + '/dev/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json().catch(() => ({}));
    await dev({ reset: true });
    const o = await openAdmin('owner', { width: 375 }); const { q, qa, text, click, byText } = o;
    const token = o.win.localStorage.getItem('mngAdminToken');
    const api = async (p, body) => (await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => ({}));
    const lines = (w) => w.qa('#viewStock .chan .chantx').map((e) => w.text(e));
    const row = (w, L) => w.qa('#viewStock .chan').find((r) => new RegExp('^' + L + '\\b').test(w.text(r.querySelector('.chantx'))));
    const btnIn = (w, L, re) => { const r = row(w, L); return r ? Array.from(r.querySelectorAll('button')).find((b) => re.test(w.text(b))) : null; };
    const lineOf = (w, L) => { const r = row(w, L); return r ? w.text(r.querySelector('.chantx')) : ''; };
    click(byText('#tabs .tab', /^Stock$/)); await until(() => lines(o).length === 2 && qa('#viewStock .line').length >= 4, 4000, 'the Meta and Google lines').catch(() => {});
    ok(lines(o).some((t) => /^Meta: /.test(t)) && lines(o).some((t) => /^Google: /.test(t)), 'the Stock screen has a line starting Meta: and one starting Google: (' + lines(o).join(' | ') + ')');
    ok(lines(o).join(' | ') === 'Meta: switched off | Google: switched off', 'both start switched off');
    const chanBox = q('#viewStock .chan') && q('#viewStock .chan').closest('.sec'), firstProduct = qa('#viewStock .line')[0];
    ok(!!chanBox && !!firstProduct && !!(chanBox.compareDocumentPosition(firstProduct) & o.win.Node.DOCUMENT_POSITION_FOLLOWING), 'the Meta and Google block sits above the item rows');
    ok(!!btnIn(o, 'Meta', /^Test with Original$/) && !!btnIn(o, 'Google', /^Test with Original$/), 'the owner sees Test with Original on each line');
    ok(!byText('#viewStock button', /^Switch on all four$/) && !byText('#viewStock button', /^Set up Google$/), 'no Switch on all four before a matching test, and no Set up Google once Google is set up');
    const tw = btnIn(o, 'Meta', /^Test with Original$/); if (tw) click(tw);
    // Test with Original pushes Original first, then reads it back (the practice Meta shows a push at once)
    const tested = /^Meta: matches, checked \d\d:\d\d$/;
    await until(() => tested.test(lineOf(o, 'Meta')), 5000, 'the test result').catch(() => {});
    ok(tested.test(lineOf(o, 'Meta')) && !!btnIn(o, 'Meta', /^Switch on all four$/), 'after Test with Original (a push, then a matching read) the Meta line says matches, with a time, and offers Switch on all four (' + lineOf(o, 'Meta') + ')');
    ok(/^Testing with Original\. Meta: /.test(text(q('#toast'))), 'a toast gives the result (' + text(q('#toast')) + ')');
    const cn = btnIn(o, 'Meta', /^Check now$/); if (cn) click(cn);
    await until(() => /^Meta: matches, checked \d\d:\d\d$/.test(lineOf(o, 'Meta')) && /\. Google: /.test(text(q('#toast'))), 5000, 'Meta to match').catch(() => {});
    ok(/^Meta: matches, checked \d\d:\d\d$/.test(lineOf(o, 'Meta')), 'Check now reads it back: Meta: matches, checked HH:MM (' + lineOf(o, 'Meta') + ')');
    ok(/^Meta: matches, checked \d\d:\d\d\. Google: switched off$/.test(text(q('#toast'))), 'Check now toasts both lines (' + text(q('#toast')) + ')');
    const st = await api('/admin/api/channels');
    const ist = st.channels?.meta?.checkedAt ? new Date(Date.parse(st.channels.meta.checkedAt) + 5.5 * 3600000).toISOString().slice(11, 16) : 'no time';
    ok(lineOf(o, 'Meta').endsWith(ist), 'the time is Indian time, HH:MM (' + ist + ')');
    ok(!!btnIn(o, 'Meta', /^Switch on all four$/) && !!btnIn(o, 'Meta', /^Check now$/) && !!btnIn(o, 'Meta', /^Switch off$/) && !btnIn(o, 'Meta', /^Test with Original$/), 'once the test matches: Switch on all four, Check now and Switch off');
    const so = btnIn(o, 'Meta', /^Switch off$/); if (so) click(so); await until(() => lineOf(o, 'Meta') === 'Meta: switched off', 4000, 'Meta off').catch(() => {});
    ok(lineOf(o, 'Meta') === 'Meta: switched off' && (await api('/admin/api/channels')).channels?.meta?.mode === 'off', 'Switch off puts Meta back to off');
    // a stock change goes out about 3 s later: the line redraws by itself, so it never keeps saying "matches" after a Pause
    await api('/admin/api/channels/mode', { channel: 'meta', mode: 'all' }); await api('/admin/api/channels/check', {});   // all four read back and matching
    click(byText('#tabs .tab', /^Orders$/)); click(byText('#tabs .tab', /^Stock$/));
    await until(() => /^Meta: matches/.test(lineOf(o, 'Meta')), 4000, 'Meta on').catch(() => {});
    const before = lineOf(o, 'Meta');
    const kes = qa('#viewStock .line').find((l) => /^Atta Kesari/.test(text(l))), pause = kes && Array.from(kes.querySelectorAll('button')).find((b) => /^Pause selling$/.test(text(b)));
    if (pause) click(pause);
    await until(() => /^Meta: waiting for Meta to update \(pushed \d\d:\d\d\)$/.test(lineOf(o, 'Meta')), 9000, 'the line to redraw').catch(() => {});
    ok(/^Meta: matches/.test(before) && /^Meta: waiting for Meta to update \(pushed \d\d:\d\d\)$/.test(lineOf(o, 'Meta')), 'after Pause selling the Meta line redraws from matches to waiting, with the push time (' + before + ' -> ' + lineOf(o, 'Meta') + ')');
    await api('/admin/api/inventory/pause', { slug: 'atta-kesari', paused: false }); await api('/admin/api/channels/mode', { channel: 'meta', mode: 'off' });
    ok(o.errors.length === 0, 'no page errors on the channel lines (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();

    const s = await openAdmin('staff', { width: 375 });
    s.click(s.byText('#tabs .tab', /^Stock$/)); await until(() => lines(s).length === 2, 4000, 'the lines for staff').catch(() => {});
    ok(lines(s).length === 2 && s.qa('#viewStock .chan button').length === 0 && !s.byText('#viewStock button', /^Test with Original$/), 'staff see both lines but no buttons (' + lines(s).join(' | ') + ')');
    s.close();

    // Set up Google: the button shows only while Google is not set up, and opens the steps
    await dev({ notSetUp: true });
    const g = await openAdmin('owner', { width: 375 });
    g.click(g.byText('#tabs .tab', /^Stock$/)); await until(() => lines(g).length === 2, 4000, 'the lines').catch(() => {});
    ok(lineOf(g, 'Google') === 'Google: not set up' && !!btnIn(g, 'Google', /^Set up Google$/) && !btnIn(g, 'Meta', /^Set up Google$/), 'Google not set up: the owner gets Set up Google on the Google line only');
    const sg = btnIn(g, 'Google', /^Set up Google$/); if (sg) g.click(sg); await until(() => g.qa('#viewStock .setup li').length > 0, 5000, 'the set-up steps').catch(() => {});
    ok(g.qa('#viewStock .setup li').length === 4 && /Found 4 of 4 products/.test(g.text(g.q('#viewStock .setup'))) && lineOf(g, 'Google') === 'Google: switched off', 'the set-up panel lists the steps, and Google is now just switched off');
    g.close();

    // a fake problem: Google keeps showing Kesari out of stock for over 30 minutes while the admin says in stock
    await dev({ stuck: { google: { 'atta-kesari': 'out of stock' } } });
    await api('/admin/api/channels/mode', { channel: 'google', mode: 'all' });
    await dev({ minutesLater: 31 });
    await api('/admin/api/channels/check', {});   // read back: what took the push now matches; Kesari still does not
    const p = await openAdmin('owner', { width: 375 });
    await until(() => p.qa('#needs .need').some((c) => /does not match the admin/.test(p.text(c))), 5000, 'the Needs card').catch(() => {});
    const need = p.qa('#needs .need').find((c) => /does not match the admin/.test(p.text(c)));
    ok(!!need && /Google does not match the admin: tap to see/.test(p.text(need)) && need.classList.contains('hot') && !p.qa('#needs .need').some((c) => /Meta does not match/.test(p.text(c))), 'a problem on Google makes a red Needs card: ' + (need ? p.text(need) : p.qa('#needs .need').map((c) => p.text(c)).join(' | ')));
    if (need) { p.click(need); await until(() => lines(p).length === 2, 4000, 'the Stock screen').catch(() => {}); }
    const red = row(p, 'Google') && row(p, 'Google').querySelector('.chantx');
    ok(!p.q('#viewStock').hidden && /^Google: Atta Kesari shows out of stock; the admin says in stock$/.test(lineOf(p, 'Google')) && !!red && red.classList.contains('bad'), 'tapping it opens Stock, where the Google line is red: ' + lineOf(p, 'Google'));
    ok(p.errors.length === 0, 'no page errors with a channel problem (' + p.errors.join(' | ').slice(0, 200) + ')');
    p.close();

    // a key not on Render: the line says so, and there is nothing to press
    await dev({ reset: true }); await dev({ noKey: ['meta'] });
    const k = await openAdmin('owner', { width: 375 });
    k.click(k.byText('#tabs .tab', /^Stock$/)); await until(() => lines(k).length === 2, 4000, 'the lines').catch(() => {});
    ok(lines(k).join(' | ') === 'Meta sync off: token not set | Google: switched off' && row(k, 'Meta') && row(k, 'Meta').querySelectorAll('button').length === 0, 'no Meta token: "Meta sync off: token not set", with no buttons (' + lines(k).join(' | ') + ')');
    k.close();

    // a malformed saved row: the bad entry is dropped, so both lines still show (T-a)
    await dev({ reset: true }); await dev({ broken: true });
    const mb = await openAdmin('owner', { width: 375 });
    mb.click(mb.byText('#tabs .tab', /^Stock$/)); await until(() => lines(mb).length === 2, 4000, 'the lines').catch(() => {});
    ok(lines(mb).join(' | ') === 'Meta: switched off | Google: switched off' && mb.errors.length === 0, 'a malformed saved row still shows both lines (' + lines(mb).join(' | ') + ')');
    mb.close();

    // the channel status cannot be read at all: the Stock screen still shows the stock
    await dev({ reset: true }); await dev({ statusFails: true });
    const b = await openAdmin('owner', { width: 375 });
    b.click(b.byText('#tabs .tab', /^Stock$/)); await until(() => b.qa('#viewStock .line').length >= 4, 4000, 'the stock list').catch(() => {});
    ok(b.qa('#viewStock .line').length >= 4 && b.qa('#viewStock .chan').length === 0 && /Could not read Meta and Google/.test(b.text(b.q('#viewStock'))) && b.errors.length === 0, 'when Meta and Google cannot be read, the Stock screen still lists the stock and says so');
    b.close();
    await dev({ reset: true });
  });

  // Meta and Google: what the owner is told when a try fails, a set-up that misses a product, the switched-off copy, and other days
  list.push(async () => {
    const dev = async (b) => (await fetch(BASE + '/dev/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json().catch(() => ({}));
    await dev({ reset: true });
    const o = await openAdmin('owner', { width: 375 });
    const token = o.win.localStorage.getItem('mngAdminToken');
    const api = async (p, body) => (await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => ({}));
    const lines = (w) => w.qa('#viewStock .chan .chantx').map((e) => w.text(e));
    const row = (w, L) => w.qa('#viewStock .chan').find((r) => new RegExp('^' + L + '\\b').test(w.text(r.querySelector('.chantx'))));
    const btnIn = (w, L, re) => { const r = row(w, L); return r ? Array.from(r.querySelectorAll('button')).find((b) => re.test(w.text(b))) : null; };
    const lineOf = (w, L) => { const r = row(w, L); return r ? w.text(r.querySelector('.chantx')) : ''; };
    const subOf = (w, L) => { const r = row(w, L); const m = r && r.querySelector('.muted'); return m ? w.text(m) : ''; };
    const toastOf = (w) => w.text(w.q('#toast'));
    const toStock = async (w) => { w.click(w.byText('#tabs .tab', /^Stock$/)); await until(() => lines(w).length === 2, 4000, 'the lines').catch(() => {}); };
    const press = (w, L, re) => { const b = btnIn(w, L, re); if (b) w.click(b); return !!b; };

    // switched off before anything was sent: Google shows the sheet (I7)
    await toStock(o);
    ok(subOf(o, 'Google') === 'Nothing is sent. Google shows the Google sheet.', 'Google switched off, nothing sent yet: it shows the Google sheet (' + subOf(o, 'Google') + ')');
    // a refused test push: the line and the toast say so at once, and Switch on all four waits (I1, I2)
    await dev({ failPush: { meta: 'Invalid OAuth access token' } });
    press(o, 'Meta', /^Test with Original$/);
    await until(() => /did not accept/.test(lineOf(o, 'Meta')), 5000, 'the refusal').catch(() => {});
    const refused = row(o, 'Meta') && row(o, 'Meta').querySelector('.chantx');
    ok(lineOf(o, 'Meta') === 'Meta did not accept the change: Invalid OAuth access token' && !!refused && refused.classList.contains('bad'), 'a refused test push shows at once, in red: ' + lineOf(o, 'Meta'));
    ok(toastOf(o) === 'Testing with Original. Meta did not accept the change: Invalid OAuth access token', 'the toast says what failed: ' + toastOf(o));
    ok(!btnIn(o, 'Meta', /^Switch on all four$/) && !!btnIn(o, 'Meta', /^Test with Original$/), 'no Switch on all four; Test with Original can be tried again');
    await dev({ failPush: { meta: null } });
    press(o, 'Meta', /^Test with Original$/);
    await until(() => /^Meta: matches/.test(lineOf(o, 'Meta')), 5000, 'the retry').catch(() => {});
    ok(/^Meta: matches, checked \d\d:\d\d$/.test(lineOf(o, 'Meta')) && !!btnIn(o, 'Meta', /^Switch on all four$/), 'tried again once Meta takes it: matches, and Switch on all four is offered (' + lineOf(o, 'Meta') + ')');
    // switched off after a push: honest about what Google keeps (I7)
    press(o, 'Google', /^Test with Original$/);
    await until(() => /^Google: (matches|waiting)/.test(lineOf(o, 'Google')), 5000, 'the Google test').catch(() => {});
    press(o, 'Google', /^Switch off$/);
    await until(() => lineOf(o, 'Google') === 'Google: switched off', 5000, 'Google off').catch(() => {});
    ok(subOf(o, 'Google') === 'Nothing is sent. Google keeps the last stock and prices sent from here, ahead of the Google sheet.', 'Google switched off after a push says what Google keeps (' + subOf(o, 'Google') + ')');
    press(o, 'Meta', /^Switch off$/);
    await until(() => lineOf(o, 'Meta') === 'Meta: switched off', 5000, 'Meta off').catch(() => {});
    ok(/^Nothing is sent\. Meta keeps the last stock and prices sent from here/.test(subOf(o, 'Meta')), 'Meta switched off after a push says the same (' + subOf(o, 'Meta') + ')');
    ok(o.errors.length === 0, 'no page errors (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();

    // refused three times: the problem line keeps the message whole, even a first word with a colon (M3)
    await dev({ reset: true }); await dev({ failPush: { meta: 'invalid: price field' } });
    await api('/admin/api/channels/mode', { channel: 'meta', mode: 'all' });
    await api('/admin/api/inventory/pause', { slug: 'atta-kesari', paused: true });
    for (let i = 0; i < 3; i++) await api('/admin/api/channels/check', {});
    const m = await openAdmin('owner', { width: 375 }); await toStock(m);
    const reds = row(m, 'Meta') ? Array.from(row(m, 'Meta').querySelectorAll('.bad')).map((e) => m.text(e)) : [];
    ok(reds.includes('Meta: did not accept the change to Atta Kesari: invalid: price field'), 'a refused change keeps the whole message: ' + JSON.stringify(reds));
    m.close();
    await api('/admin/api/inventory/pause', { slug: 'atta-kesari', paused: false });

    // a set-up that misses an offer id says so, and offers Set up Google again until it is fixed (I3, M4)
    await dev({ reset: true }); await dev({ notSetUp: true }); await dev({ setupMissing: ['MNG-LITE-250'] });
    const g = await openAdmin('owner', { width: 375 }); await toStock(g);
    press(g, 'Google', /^Set up Google$/);
    await until(() => g.qa('#viewStock .setup li').length > 0, 5000, 'the set-up steps').catch(() => {});
    ok(toastOf(g) === 'Google is set up, but 1 product was not found; see below.', 'the set-up toast says a product was not found: ' + toastOf(g));
    ok(/Not found in Merchant Center: MNG-LITE-250/.test(g.q('#viewStock .setup') ? g.text(g.q('#viewStock .setup')) : ''), 'and the set-up panel names it');
    ok(!!btnIn(g, 'Google', /^Set up Google again$/), 'the Google line offers Set up Google again while an offer id is missing');
    ok(/^Not found in Merchant Center: MNG-LITE-250\. Fix the offer ID in the Google sheet, then tap Set up Google again\./.test(subOf(g, 'Google')), 'and says which one, and what to do (' + subOf(g, 'Google') + ')');
    await dev({ setupMissing: [] });
    press(g, 'Google', /^Set up Google again$/);
    await until(() => /Found 4 of 4 products/.test(g.q('#viewStock .setup') ? g.text(g.q('#viewStock .setup')) : ''), 5000, 'the second set-up').catch(() => {});
    ok(toastOf(g) === 'Google is set up. Now tap Test with Original.' && !btnIn(g, 'Google', /^Set up Google again$/), 'set up again once fixed: the usual toast, and no Set up Google again (' + toastOf(g) + ')');
    ok(g.errors.length === 0, 'no page errors in set-up (' + g.errors.join(' | ').slice(0, 200) + ')');
    g.close();

    // a check from another day carries the day: "yesterday 10:42", then "1 Nov 10:42" (M1, Indian time)
    const IST = 5.5 * 3600000, MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const ist = (iso) => new Date(Date.parse(iso) + IST).toISOString();
    await dev({ reset: true }); await dev({ minutesLater: -1440 });
    await api('/admin/api/channels/mode', { channel: 'meta', mode: 'test' });
    await dev({ minutesLater: 0 });
    const y = await openAdmin('owner', { width: 375 }); await toStock(y);
    const yAt = (await api('/admin/api/channels')).channels?.meta?.checkedAt;
    ok(!!yAt && lineOf(y, 'Meta') === 'Meta: matches, checked yesterday ' + ist(yAt).slice(11, 16), 'a check made yesterday reads "checked yesterday HH:MM": ' + lineOf(y, 'Meta'));
    y.close();
    await dev({ minutesLater: -2880 }); await api('/admin/api/channels/check', {}); await dev({ minutesLater: 0 });
    const d2 = await openAdmin('owner', { width: 375 }); await toStock(d2);
    const dAt = (await api('/admin/api/channels')).channels?.meta?.checkedAt;
    const dl = dAt ? Number(ist(dAt).slice(8, 10)) + ' ' + MON[Number(ist(dAt).slice(5, 7)) - 1] + ' ' + ist(dAt).slice(11, 16) : 'no time';
    ok(lineOf(d2, 'Meta') === 'Meta: matches, checked ' + dl, 'an older check gives the date (' + dl + '): ' + lineOf(d2, 'Meta'));
    d2.close();
    await dev({ reset: true });
  });


  // Task 6b: packaging is a hand-kept list (8 Nov 2026)
  list.push(async () => {
    const IST = 5.5 * 3600000, MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const todayWords = () => { const d = new Date(Date.now() + IST); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };
    const o = await openAdmin('owner', { width: 375 }); const { q, qa, text, click } = o;
    click(o.byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    const view = () => text(q('#viewStock'));
    const rowOf = (re) => qa('#viewStock .line').find((l) => re.test(text(l)));
    const btnsOf = (re) => Array.from((rowOf(re) || o.doc.createElement('i')).querySelectorAll('button')).map((b) => text(b));
    ok(!!o.byText('#viewStock h3', /^Packaging \(counted by hand\)$/), 'Stock has a section "Packaging (counted by hand)"');
    ok(!o.byText('#viewStock h3', /Packaging and supplies/), 'the old "Packaging and supplies" section is gone');
    const sec = o.byText('#viewStock .sec', /^Packaging \(counted by hand\)/);
    const packRows = sec ? Array.from(sec.querySelectorAll('.line')) : [];
    ok(packRows.length >= 3 && packRows.every((l) => /no count/.test(text(l))), 'every packaging row says "no count" at the start (' + packRows.map((l) => text(l).slice(0, 40)).join(' | ') + ')');
    ok(packRows.every((l) => !/Not counted yet|OK|LOW|OUT/.test(Array.from(l.querySelectorAll('.badge')).map((b) => text(b)).join('|'))), 'no alert badge on a packaging row with no count');
    const tape = btnsOf(/Mono carton: Kesari/);
    ok(tape.includes('Set count') && tape.includes('Remove') && tape.some((b) => /^Low level/.test(b)) && !tape.includes('Receive') && !tape.includes('Take out'), 'the owner sees Set count, Low level and Remove on a packaging row (' + tape.join(',') + ')');
    ok(!!o.byText('#viewStock button', /^Add packaging item$/) && !o.byText('#viewStock button', /^Add item$/), 'the owner has Add packaging item');
    const prods = btnsOf(/Atta Kesari/);
    ok(prods.includes('Receive') && prods.includes('Count'), 'a biscuit row is unchanged (' + prods.join(',') + ')');
    // biscuits only arrive through New delivery, and it lists the four biscuits only (Task 11 changed this check: it was the Receive stock picker)
    click(o.byText('#viewStock button', /^New delivery$/)); await until(() => qa('#viewStock .dlrow').length === 4, 4000, 'New delivery');
    const picks = qa('#viewStock .dlrow h3').map((b) => text(b));
    ok(picks.length === 4 && picks.every((t) => /^Atta /.test(t)) && !/Mono carton: Kesari|Mono carton|Stamp/.test(picks.join('|')), 'New delivery lists the four biscuits only (' + picks.join(' | ') + ')');
    click(o.byText('#viewStock button', /^Back to Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 3000, 'back');
    // Set count
    click(Array.from(rowOf(/Mono carton: Kesari/).querySelectorAll('button')).find((b) => /^Set count$/.test(text(b))));
    await until(() => /Count: Mono carton: Kesari/.test(view()), 3000, 'the count form');
    ok(/No count yet/.test(view()), 'the count form says there is no count yet');
    const inp = qa('#viewStock input')[0]; o.set(inp, '40');
    click(o.byText('#viewStock button', /^Save count$/));
    await until(() => /40/.test(text(rowOf(/Mono carton: Kesari/) || o.doc.createElement('i'))) && /counted/.test(text(rowOf(/Mono carton: Kesari/) || o.doc.createElement('i'))), 4000, 'the new count on the row');
    ok(new RegExp('40.*counted ' + todayWords()).test(text(rowOf(/Mono carton: Kesari/))), 'the row shows the count and the IST day it was counted: ' + text(rowOf(/Mono carton: Kesari/)).slice(0, 80));
    ok(!/no count/.test(text(rowOf(/Mono carton: Kesari/))) && /no count/.test(text(rowOf(/Mono carton: Original/))), 'only the counted row lost "no count"');
    // Remove (confirm first)
    let asked = ''; o.win.confirm = (m) => { asked = m; return true; };
    click(Array.from(rowOf(/Mono carton: Kesari/).querySelectorAll('button')).find((b) => /^Remove$/.test(text(b))));
    await until(() => !rowOf(/Mono carton: Kesari/), 4000, 'the removed row to go');
    ok(asked === 'Remove Mono carton: Kesari from the list? Its history is kept.', 'Remove asks first, in plain words (' + asked + ')');
    ok(!/Mono carton: Kesari/.test(view()), 'the removed item is off the screen');
    // add it back
    const answers = ['mono carton: kesari', 'cartons']; o.win.prompt = () => answers.shift();
    click(o.byText('#viewStock button', /^Add packaging item$/));
    await until(() => !!rowOf(/Mono carton: Kesari/), 4000, 'the item to come back');
    ok(/40/.test(text(rowOf(/Mono carton: Kesari/))) && /counted/.test(text(rowOf(/Mono carton: Kesari/))), 'adding the same name brings the item back with its count (' + text(rowOf(/Mono carton: Kesari/)).slice(0, 80) + ')');
    ok(qa('#viewStock .line').filter((l) => /Mono carton: Kesari/i.test(text(l))).length === 1 && !/Mono carton Kesari/.test(view()), 'it came back as the same row, not a second one');
    // a count of 0 is recorded too
    click(Array.from(rowOf(/Stamp \/ batch labels/).querySelectorAll('button')).find((b) => /^Set count$/.test(text(b))));
    await until(() => /Count: Stamp/.test(view()), 3000, 'the count form for labels');
    o.set(qa('#viewStock input')[0], '0'); click(o.byText('#viewStock button', /^Save count$/));
    await until(() => /counted/.test(text(rowOf(/Stamp \/ batch labels/) || o.doc.createElement('i'))), 4000, 'the 0 count on the row');
    ok(new RegExp('0 labels, counted ' + todayWords()).test(text(rowOf(/Stamp \/ batch labels/))) && !/no count/.test(text(rowOf(/Stamp \/ batch labels/))), 'a first count of 0 shows "0 labels, counted today": ' + text(rowOf(/Stamp \/ batch labels/)).slice(0, 80));
    ok(/^Count saved: 0 labels/.test(text(q('#toast'))), 'the toast gives the saved result (' + text(q('#toast')) + ')');
    ok(o.errors.length === 0, 'no page errors (' + o.errors.join(' | ').slice(0, 200) + ')');
    o.close();
    // staff: Set count yes, owner-only controls no
    const s = await openAdmin('staff', { width: 375 });
    click(s.byText('#tabs .tab', /^Stock$/)); await until(() => s.qa('#viewStock .line').length >= 4, 4000, 'the stock page for staff');
    const sb = Array.from((s.qa('#viewStock .line').find((l) => /Mono carton: Kesari/.test(s.text(l))) || s.doc.createElement('i')).querySelectorAll('button')).map((b) => s.text(b));
    ok(sb.includes('Set count') && !sb.includes('Remove') && !sb.some((b) => /Low level/.test(b)), 'staff see Set count only (' + sb.join(',') + ')');
    ok(!s.byText('#viewStock button', /^Add packaging item$/), 'staff have no Add packaging item');
    ok(s.errors.length === 0, 'no page errors for staff (' + s.errors.join(' | ').slice(0, 200) + ')');
    s.close();
  });

  // Task 11: New delivery on the phone (375 px): one screen, a review with every warning ticked, one Save, and the form kept on the
  // phone when the signal drops (receipt id: a resend never saves twice).
  list.push(async () => {
    const IST = 330 * 60000, MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const istDay = (n) => new Date(Date.now() + IST - n * 86400000).toISOString().slice(0, 10);
    const words = (iso) => Number(iso.slice(8, 10)) + ' ' + MON[Number(iso.slice(5, 7)) - 1] + ' ' + iso.slice(0, 4);
    const yymmdd = (iso) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
    const BAKE1 = istDay(10), BAKE2 = istDay(1);
    const BILL = 'T11-' + String(Date.now()).slice(-7);
    const NOSIG = 'Not sent. Saved on this phone. Tap Send when you have signal.';
    const KEY = 'mngDeliveryDraft';
    const SLUGS = ['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar'];
    const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
    // jsdom draws nothing, so "no horizontal scroll" is checked by what could cause it: no fixed width or grid track wider than the
    // 343 px between the 16 px gutters, and no long text that may not wrap. The real 375 px page is measured in the browser (task report).
    const tooWide = (w) => {
      const bad = [];
      w.qa('#viewStock *').forEach((el) => {
        const cs = w.win.getComputedStyle(el), name = el.id || el.className || el.tagName;
        for (const p of ['width', 'minWidth']) { const m = /^([\d.]+)px$/.exec(cs[p] || ''); if (m && Number(m[1]) > 343) bad.push(name + ' ' + p + ' ' + cs[p]); }
        if (/grid/.test(cs.display) && !/minmax\(0/.test(cs.gridTemplateColumns || '')) bad.push(name + ' grid ' + cs.gridTemplateColumns);
        if (cs.whiteSpace === 'nowrap' && w.text(el).length > 24) bad.push(name + ' nowrap ' + w.text(el).slice(0, 30));
      });
      return bad;
    };
    const rowOf = (w, slug, i) => w.qa('#viewStock .dlrow[data-slug="' + slug + '"]')[i || 0];
    const fieldOf = (w, slug, f, i) => (rowOf(w, slug, i) || w.doc.createElement('i')).querySelector('[data-f="' + f + '"]');
    const review = (w) => w.text(w.q('#dlReview'));
    const addPhoto = (w, input) => {
      w.win.__shrinkPhoto = () => Promise.resolve(JPEG);   // jsdom has no canvas; the server still checks the photo
      Object.defineProperty(input, 'files', { value: [new w.win.File(['x'], 'broken.jpg', { type: 'image/jpeg' })], configurable: true });
      input.dispatchEvent(new w.win.Event('change', { bubbles: true }));
    };
    const toNew = async (w) => {
      w.click(w.byText('#tabs .tab', /^Stock$/)); await until(() => w.qa('#viewStock .line').length >= 4, 4000, 'the stock page');
      w.click(w.byText('#viewStock button', /^New delivery$/));
    };

    const s = await openAdmin('staff', { width: 375 }); const { q, qa, text, click, byText, set } = s;
    const token = s.win.localStorage.getItem('mngAdminToken');
    const apiGet = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } })).json());
    click(byText('#tabs .tab', /^Stock$/)); await until(() => qa('#viewStock .line').length >= 4, 4000, 'the stock page');
    ok(!!byText('#viewStock button', /^New delivery$/), 'staff have a New delivery button at the top of Stock');
    const kes = qa('#viewStock .line').find((l) => /Atta Kesari/.test(text(l)));
    click(Array.from(kes.querySelectorAll('button')).find((b) => /^Receive$/.test(text(b))));
    await until(() => qa('#viewStock .dlrow').length === 4, 4000, 'New delivery from a biscuit\'s Receive');
    ok(/^New delivery/.test(text(q('#viewStock .pagehead'))), 'a biscuit\'s Receive opens New delivery');
    await until(() => fieldOf(s, 'atta-original', 'rateRupees').value !== '', 4000, 'the prefilled rates').catch(() => {});
    ok(SLUGS.map((x) => fieldOf(s, x, 'rateRupees').value).join('/') === '85/100/85/125', 'rates are prefilled 85/100/85/125 (' + SLUGS.map((x) => fieldOf(s, x, 'rateRupees').value).join('/') + ')');
    ok([q('#dl-busPerCarton').value, q('#dl-delhiPerCarton').value, q('#dl-porter').value, q('#dl-other').value].join('/') === '0/20/2000/0', 'freight is prefilled: bus 0, Delhi Rs 20 a carton, porter Rs 2,000, other 0 (' + [q('#dl-busPerCarton').value, q('#dl-delhiPerCarton').value, q('#dl-porter').value, q('#dl-other').value].join('/') + ')');
    ok(q('#dl-supplier').value === 'Krazy Bakers' && q('#dl-arrivedOn').value === istDay(0) && q('#dl-bakeDate').value === '', 'Krazy Bakers, arrived today, bake date empty');
    ok(!!q('#dl-gstRupees') && /GST on the bill \(Rs, 0 if none\)/.test(text(q('#viewStock'))), 'the top block has "GST on the bill (Rs, 0 if none)"');
    ok(['invoiceBoxes', 'counted', 'broken'].every((f) => qa('#viewStock .dlrow [data-f="' + f + '"]').every((i) => i.getAttribute('inputmode') === 'numeric'))
      && qa('#viewStock .dlrow [data-f="rateRupees"]').every((i) => i.getAttribute('inputmode') === 'decimal') && ['invoiceRupees', 'gstRupees', 'porter'].every((k) => q('#dl-' + k).getAttribute('inputmode') === 'decimal') && q('#dl-cartons').getAttribute('inputmode') === 'numeric', 'number fields open the number keypad');
    ok(qa('#viewStock .dlrow h3').map((h) => text(h)).join('|') === 'Atta Original|Atta Kesari|Atta Ajwain|Atta Sugar-Lite', 'four flavour rows');
    let bad = tooWide(s); ok(bad.length === 0, 'the form has nothing wider than the phone (' + bad.slice(0, 4).join(' | ') + ')');
    // the Review button names the first thing missing
    set(q('#dl-billNo'), BILL);
    ok(review(s) === 'Enter the bake date' && q('#dlReview').disabled, 'bake date empty: the Review button says "Enter the bake date" (' + review(s) + ')');
    set(q('#dl-bakeDate'), BAKE1); set(q('#dl-cartons'), '4'); set(q('#dl-invoiceRupees'), '7800');   // the rates make 7,900: Rs 100 off
    for (const x of SLUGS) { set(fieldOf(s, x, 'invoiceBoxes'), '20'); set(fieldOf(s, x, 'counted'), '20'); }
    ok(review(s) === 'Review' && !q('#dlReview').disabled, 'with everything entered the button says Review (' + review(s) + ')');
    const bk = rowOf(s, 'atta-original').querySelector('.dlbroken');
    ok(!!bk && bk.hidden, 'no broken boxes: the broken-box questions are hidden');
    set(fieldOf(s, 'atta-original', 'broken'), '2');
    ok(!bk.hidden && /Why did they break\?/.test(text(bk)) && /On the bus/.test(text(bk)) && /At the bakery/.test(text(bk)) && /Photo of the broken boxes/.test(text(bk)), 'broken 2: why did they break (on the bus / at the bakery) and the photo appear');
    click(Array.from(bk.querySelectorAll('button')).find((b) => /^On the bus$/.test(text(b))));
    ok(review(s) === 'Atta Original: add a photo of the broken boxes' && q('#dlReview').disabled, 'broken 2 with no photo: the photo is required (' + review(s) + ')');
    addPhoto(s, fieldOf(s, 'atta-original', 'brokenPhoto'));
    await until(() => /Photo added/.test(text(bk)), 4000, 'the photo to upload').catch(() => {});
    ok(/Photo added/.test(text(bk)) && review(s) === 'Review', 'the photo is shrunk, sent and noted (' + text(bk).slice(-40) + ' / ' + review(s) + ')');
    const df = rowOf(s, 'atta-kesari').querySelector('.dldiff');
    ok(!!df && df.hidden, 'counted = bill: no reason asked');
    set(fieldOf(s, 'atta-kesari', 'counted'), '19');
    ok(!df.hidden && /Why is the count different from the bill\?/.test(text(df)) && review(s) === 'Atta Kesari: say why the count is different from the bill', 'counted 19 against 20: the reason is asked (' + review(s) + ')');
    set(fieldOf(s, 'atta-kesari', 'diffReason'), 'one box short');
    const d0 = JSON.parse(s.win.localStorage.getItem(KEY) || '{}');
    ok(/^d-[0-9a-z]+-[0-9a-z]{6}$/.test(d0.id || '') && d0.form && d0.form.billNo === BILL && d0.form.rows.find((r) => r.slug === 'atta-kesari').diffReason === 'one box short' && /^\d{4}\/\d{2}\/[0-9a-f]{16}\.jpg$/.test(d0.form.rows[0].brokenPhoto || ''), 'every entry is kept on the phone with one receipt id (' + (d0.id || 'none') + ')');
    // review
    click(q('#dlReview'));
    await until(() => qa('#viewStock .dllot').length === 4, 5000, 'the review screen').catch(() => {});
    ok(/^Check and save/.test(text(q('#viewStock .pagehead'))) && qa('#viewStock .dllot').length === 4, 'Review lists four lots');
    const codes = qa('#viewStock .dllot .dlcode').map((c) => text(c));
    ok(codes.length === 4 && codes.every((c, i) => c === 'MNG' + 'OKAL'[i] + '-' + yymmdd(BAKE1) + '-01'), 'each lot shows its code (' + codes.join(', ') + ')');
    const lot0 = text(qa('#viewStock .dllot')[0]);
    ok(/Atta Original/.test(lot0) && /18 good boxes/.test(lot0), 'Original: 18 good boxes (20 counted, 2 broken)');
    ok(/Baked/.test(lot0) && lot0.includes(words(BAKE1)) && /Website stops/.test(lot0) && /Last ship/.test(lot0) && /Best before/.test(lot0) && /\d+ [A-Z][a-z]{2} 20\d\d/.test(lot0), 'the four dates, in words (' + lot0.slice(0, 160) + ')');
    ok(/Cost per good box Rs \d+\.\d\d/.test(lot0), 'cost per good box in rupees with paise (' + (lot0.match(/Cost per good box[^·]*/) || [''])[0] + ')');
    const ticks = qa('#viewStock .dlwarn input[type=checkbox]');
    const keys = ticks.map((t) => t.getAttribute('data-key')).sort().join(',');
    ok(keys === 'invoice_mismatch,old_bake', 'two warnings to tick: the old bake and the bill total (' + keys + ')');
    ok(q('#dlSave') && q('#dlSave').disabled, 'Save is disabled until every warning is ticked');
    click(ticks.find((t) => t.getAttribute('data-key') === 'invoice_mismatch'));
    ok(q('#dlSave').disabled, 'one of two ticked: Save still disabled');
    click(ticks.find((t) => t.getAttribute('data-key') === 'old_bake'));
    ok(!!q('#dlOldReason') && !q('#dlOldReason').closest('[hidden]') && q('#dlSave').disabled, 'ticking the old bake asks for a reason, and Save waits for it');
    set(q('#dlOldReason'), 'Bus strike in Bikaner');
    ok(!q('#dlSave').disabled, 'every warning ticked and the reason given: Save is enabled');
    bad = tooWide(s); ok(bad.length === 0, 'the review screen has nothing wider than the phone (' + bad.slice(0, 4).join(' | ') + ')');
    // no signal: the save never reaches the server
    const real = s.win.fetch; let dropped = 0;
    s.win.fetch = (u, o) => { if (!dropped && /\/admin\/api\/stock\/deliveries$/.test(String(u)) && o && o.method === 'POST') { dropped++; return Promise.reject(new TypeError('Failed to fetch')); } return real(u, o); };
    click(q('#dlSave'));
    await until(() => !!q('#dlNosig'), 4000, 'the no-signal line').catch(() => {});
    ok(dropped === 1 && text(q('#dlNosig')) === NOSIG && !!byText('#viewStock button', /^Send$/), 'no signal: "' + NOSIG + '" and a Send button (' + text(q('#dlNosig')) + ')');
    const kept = s.win.localStorage.getItem(KEY);
    ok(!!kept && JSON.parse(kept).id === d0.id && JSON.parse(kept).pending && JSON.parse(kept).pending.id === d0.id, 'the delivery stays on the phone with the same receipt id');
    ok(s.errors.length === 0, 'no page errors on the form and review (' + s.errors.join(' | ').slice(0, 200) + ')');
    s.close();
    // the phone reloads the page: the same delivery, Send saves it once
    const r = await openAdmin('staff', { width: 375 });
    r.win.localStorage.setItem(KEY, kept);
    await toNew(r);
    await until(() => !!r.q('#dlNosig'), 4000, 'the restored delivery').catch(() => {});
    ok(r.text(r.q('#dlNosig')) === NOSIG && !!r.byText('#viewStock button', /^Send$/), 'after a reload the page still says not sent and offers Send');
    r.click(r.byText('#viewStock button', /^Edit$/)); await until(() => r.qa('#viewStock .dlrow').length === 4, 3000, 'the form').catch(() => {});
    ok(r.q('#dl-billNo').value === BILL && r.q('#dl-bakeDate').value === BAKE1 && r.q('#dl-cartons').value === '4' && r.q('#dl-invoiceRupees').value === '7800'
      && fieldOf(r, 'atta-kesari', 'counted').value === '19' && fieldOf(r, 'atta-original', 'broken').value === '2' && fieldOf(r, 'atta-kesari', 'diffReason').value === 'one box short' && /Photo added/.test(r.text(rowOf(r, 'atta-original'))), 'the reload restores every typed value from the phone');
    let asked = ''; r.win.confirm = (m) => { asked = m; return false; };
    r.click(r.byText('#viewStock button', /^Start a new one$/));
    ok(/Throw away/.test(asked) && r.q('#dl-billNo').value === BILL, 'Start a new one asks first, and No keeps the delivery (' + asked + ')');
    r.win.confirm = () => true;
    ok(r.text(r.q('#dlNosig')) === NOSIG, 'the form says it is not sent yet');
    r.click(r.byText('#viewStock button', /^Send$/));
    await until(() => /^Delivery /.test(r.text(r.q('#viewStock .pagehead'))) && r.qa('#viewStock .dlotline').length === 4, 5000, 'the delivery page').catch(() => {});
    const lotLines = r.qa('#viewStock .dlotline');
    ok(new RegExp('^Delivery ' + BILL).test(r.text(r.q('#viewStock .pagehead'))) && lotLines.length === 4 && lotLines.every((l) => /On hold/.test(r.text(l.querySelector('.badge')))), 'Send saves it and opens the delivery page with 4 lots On hold (' + lotLines.map((l) => r.text(l).slice(0, 50)).join(' | ') + ')');
    ok(/To raise with Krazy Bakers/.test(r.text(r.q('#viewStock'))) && /Atta Kesari: bill 20, counted 19/.test(r.text(r.q('#viewStock'))), 'the delivery page lists what to raise with Krazy Bakers');
    ok(/Send the bus company a written note of the breakage/.test(r.text(r.q('#viewStock'))), 'and the note for the bus company');
    ok(r.win.localStorage.getItem(KEY) === null, 'the saved delivery is cleared from the phone');
    const mine = ((await apiGet('/admin/api/stock/lots')).lots || []).filter((l) => (l.code || '').includes('-' + yymmdd(BAKE1) + '-'));
    ok(mine.length === 4 && mine.every((l) => l.status === 'hold'), 'exactly one delivery was saved: 4 lots, not 8 (' + mine.map((l) => l.code).join(',') + ')');
    r.click(r.byText('#viewStock button', /^Back to Stock$/)); await until(() => !!r.byText('#viewStock button', /^New delivery$/), 4000, 'back to Stock').catch(() => {});
    r.click(r.byText('#viewStock button', /^New delivery$/)); await until(() => r.qa('#viewStock .dlrow').length === 4, 4000, 'a fresh form').catch(() => {});
    ok(r.q('#dl-billNo').value === '' && !r.q('#dlNosig') && !r.byText('#viewStock button', /^Start a new one$/), 'after the save, the next New delivery on this phone starts empty');
    ok(r.errors.length === 0, 'no page errors after the reload (' + r.errors.join(' | ').slice(0, 200) + ')');
    r.close();

    // a second delivery: the server's refusal on the form, a warning that comes back at Save, a reply lost on the way back
    const t = await openAdmin('staff', { width: 375 });
    await toNew(t); await until(() => t.qa('#viewStock .dlrow').length === 4 && fieldOf(t, 'atta-original', 'rateRupees').value !== '', 4000, 'a fresh form');
    t.set(t.q('#dl-billNo'), BILL); t.set(t.q('#dl-bakeDate'), BAKE2); t.set(t.q('#dl-cartons'), '1'); t.set(t.q('#dl-invoiceRupees'), '100');
    t.set(fieldOf(t, 'atta-original', 'invoiceBoxes'), '1'); t.set(fieldOf(t, 'atta-original', 'counted'), '1'); t.set(fieldOf(t, 'atta-original', 'rateRupees'), '100');
    t.click(t.q('#dlReview'));
    await until(() => /already saved/.test(t.text(t.q('#dlErr'))), 4000, 'the refusal').catch(() => {});
    ok(new RegExp('^Bill ' + BILL + ' part 1 is already saved .*Tap "Add part 2" if this is the rest\\.$').test(t.text(t.q('#dlErr'))) && t.qa('#viewStock .dlrow').length === 4, 'a refusal from the server shows its message on the form (' + t.text(t.q('#dlErr')) + ')');
    t.click(t.q('#dl-addPart'));
    t.click(t.q('#dlReview'));
    await until(() => t.qa('#viewStock .dllot').length === 1, 4000, 'the review of part 2').catch(() => {});
    ok(t.qa('#viewStock .dllot').length === 1 && /part 2/.test(t.text(t.q('#viewStock'))), 'Add part 2 to an earlier bill: the review is for part 2');
    const tickAll = () => t.qa('#viewStock .dlwarn input[type=checkbox]').forEach((c) => { if (!c.checked) t.click(c); });
    tickAll();
    const realT = t.win.fetch; let step = 0;
    t.win.fetch = async (u, o) => {
      if (/\/admin\/api\/stock\/deliveries$/.test(String(u)) && o && o.method === 'POST') {
        step++;
        if (step === 1) return new Response(JSON.stringify({ ok: false, error: 'Check these before saving', warnings: [{ key: 'large', text: 'Practice: a warning that appeared after the review.' }] }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        if (step === 2) { await realT(u, o); throw new TypeError('Failed to fetch'); }   // it reached the server; the reply was lost
      }
      return realT(u, o);
    };
    t.click(t.q('#dlSave'));
    await until(() => /a warning that appeared after the review/.test(t.text(t.q('#viewStock'))), 4000, 'the warning from Save').catch(() => {});
    const late = t.qa('#viewStock .dlwarn input[type=checkbox]').find((c) => c.getAttribute('data-key') === 'large');
    ok(!!late && !late.checked && t.qa('#viewStock .dllot').length === 1 && t.q('#dlSave').disabled, 'a 409 at Save brings the review back with the new warning to tick, Save disabled');
    t.click(late); ok(!t.q('#dlSave').disabled, 'ticked: Save is enabled again');
    t.click(t.q('#dlSave'));
    await until(() => !!t.q('#dlNosig'), 4000, 'the lost reply').catch(() => {});
    ok(t.text(t.q('#dlNosig')) === NOSIG, 'a lost reply also says not sent');
    t.click(t.byText('#viewStock button', /^Send$/));
    await until(() => /^Delivery /.test(t.text(t.q('#viewStock .pagehead'))), 5000, 'the delivery page').catch(() => {});
    ok(/^Delivery /.test(t.text(t.q('#viewStock .pagehead'))) && /part 2/.test(t.text(t.q('#viewStock'))) && t.qa('#viewStock .dlotline').length === 1, 'Send after a lost reply opens the delivery saved the first time');
    ok(t.win.localStorage.getItem(KEY) === null, 'and clears it from the phone');
    const mine2 = ((await apiGet('/admin/api/stock/lots')).lots || []).filter((l) => (l.code || '').includes('-' + yymmdd(BAKE2) + '-'));
    ok(mine2.length === 1, 'the resend saved nothing twice: 1 lot, not 2 (' + mine2.map((l) => l.code).join(',') + ')');
    ok(t.errors.length === 0, 'no page errors on the second delivery (' + t.errors.join(' | ').slice(0, 200) + ')');
    t.close();
  });

  return list;
};
