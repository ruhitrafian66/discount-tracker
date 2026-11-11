'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/engine');

let seq = 0;
function offer(shop, heading, price, { pre = null, size = 500, unit = 'g', pieces = 1, desc = '' } = {}) {
  return {
    id: 'o' + ++seq, heading, description: desc,
    pricing: { price, pre_price: pre, currency: 'NOK' },
    quantity: { unit: { symbol: unit }, size: { from: size, to: size }, pieces: { from: pieces, to: pieces } },
    dealer: { name: shop, logo: '', color: '' },
    images: { thumb: '' }, run_from: '2026-11-09T00:00:00+0000', run_till: '2026-11-15T22:59:59+0000',
  };
}
function kp(store, name, price, weight = 500, unit = 'g') {
  return { name, brand: '', store: { name: store }, weight, weight_unit: unit, current_price: price, price_history: [{ price, date: '2026-11-01' }] };
}
const NOW = Date.parse('2026-11-11T12:00:00Z');
const shops = ['kiwi', 'rema 1000', 'extra', 'meny'];
const smor = { id: 't1', name: 'Smør', terms: ['smør', '*smør'], exclude: ['kryddersmør', 'peanøtt'] };
const items = (shopList) => shopList.flatMap((s) => s.items.map((i) => [s.name, i.heading]));

test('only the cheapest offer by unit price is kept', () => {
  const offers = [
    offer('KIWI', 'Meierismør', 49.9, { pre: 72.9 }),
    offer('REMA 1000', 'Smør', 39.9, { pre: 69.9 }),
    offer('Extra', 'Smør 250 g', 24.9, { pre: 40, size: 250 }), // 99.6/kg > 79.8/kg
  ];
  const r = E.compute({ offers, trackedItems: [smor], shopKeys: shops, now: NOW });
  assert.deepEqual(items(r.shops), [['REMA 1000', 'Smør']]);
  assert.equal(r.dropped.length, 2);
  assert.match(r.dropped[0].reason, /Cheaper at REMA 1000/);
});

test('dropped when another shop regular price is below the discount (via Kassalapp)', () => {
  const offers = [offer('KIWI', 'Meierismør', 49.9, { pre: 72.9 })];
  const kassal = { t1: [kp('Meny', 'Meny Smør', 45)] };
  const r = E.compute({ offers, trackedItems: [smor], shopKeys: shops, kassal, now: NOW });
  assert.equal(r.shops.length, 0);
  assert.match(r.dropped[0].reason, /Regular price at Meny is lower/);
});

test('regular prices at shops the user does not use are ignored', () => {
  const offers = [offer('KIWI', 'Meierismør', 49.9, { pre: 72.9 })];
  const kassal = { t1: [kp('Oda', 'Smør', 30)] };
  const r = E.compute({ offers, trackedItems: [smor], shopKeys: shops, kassal, now: NOW });
  assert.deepEqual(items(r.shops), [['KIWI', 'Meierismør']]);
});

test('reference price falls back to description, then Kassalapp same shop, then other shops', () => {
  const desc = offer('KIWI', 'Meierismør', 49.9, { desc: 'Tine, 500 g. Førpris 72,90' });
  let r = E.compute({ offers: [desc], trackedItems: [smor], shopKeys: shops, now: NOW });
  assert.equal(r.shops[0].items[0].regular.price, 72.9);

  const bare = offer('KIWI', 'Meierismør', 49.9);
  r = E.compute({ offers: [bare], trackedItems: [smor], shopKeys: shops, now: NOW,
    kassal: { t1: [kp('Kiwi', 'Tine Meierismør', 74.9), kp('Meny', 'Tine Meierismør', 76.9)] } });
  assert.equal(r.shops[0].items[0].regular.price, 74.9);
  assert.match(r.shops[0].items[0].regular.source, /Kassalapp/);

  r = E.compute({ offers: [bare], trackedItems: [smor], shopKeys: shops, now: NOW,
    kassal: { t1: [kp('Meny', 'Tine Meierismør', 76.9)] } });
  assert.equal(r.shops[0].items[0].regular.price, 76.9);
  assert.match(r.shops[0].items[0].regular.source, /elsewhere: Meny/);
});

test('item without any reference regular price is dropped with a reason', () => {
  const r = E.compute({ offers: [offer('KIWI', 'Meierismør', 49.9)], trackedItems: [smor], shopKeys: shops, now: NOW });
  assert.equal(r.shops.length, 0);
  assert.match(r.dropped[0].reason, /^No reference regular price found/);
});

test('word matching: prefix by default, * for compound endings', () => {
  const egg = { id: 'e', name: 'Egg', terms: ['egg'] };
  assert.ok(E.itemMatches(egg, 'Gårdsegg', '') === false);
  assert.ok(E.itemMatches(egg, 'Egg 12 stk', ''));
  assert.ok(!E.itemMatches(egg, 'Coop pålegg/salater', ''));
  assert.ok(!E.itemMatches(egg, 'Libresse truseinnlegg', ''));
  const egg2 = { id: 'e', name: 'Egg', terms: ['egg', '*egg'], exclude: ['pålegg', 'innlegg'] };
  assert.ok(E.itemMatches(egg2, 'Gårdsegg', ''));
  assert.ok(!E.itemMatches(egg2, 'Coop pålegg', ''));
  assert.ok(!E.itemMatches(egg2, 'Sleggeburger', ''));
  assert.ok(!E.itemMatches(egg2, 'Skjeggerød pepperbiff', ''));
  const smor = { id: 's', name: 'Smør', terms: ['*smør'] };
  assert.ok(E.itemMatches(smor, 'Meierismør', ''));
  assert.ok(E.itemMatches({ id: 'k', name: 'K', terms: ['kylling'] }, 'KYLLINGFILET', ''));
  assert.ok(!E.itemMatches({ id: 'k', name: 'K', terms: ['kaffe'] }, 'Iskaffe', ''));
});

test('matching ignores æøå spelling differences', () => {
  const k = { id: 'k', name: 'kjottdeig', terms: ['kjottdeig'] };
  assert.ok(E.itemMatches(k, 'COOP KJØTTDEIG', '14% fett'));
  assert.ok(E.itemMatches({ id: 'k', name: 'K', terms: ['kjøttdeig'] }, 'Kjottdeig', ''));
  assert.ok(E.itemMatches({ id: 'b', name: 'B', terms: ['blabaer'] }, 'Blåbær', ''));
  assert.ok(!E.itemMatches({ id: 'k', name: 'K', terms: ['kjottdeig'], exclude: ['kylling'] }, 'KYLLINGKJØTTDEIG', ''));
});

test('Kassalapp search terms use the spelling seen in flyers and drop *', () => {
  const offers = [offer('Extra', 'Coop Kjøttdeig', 110), offer('KIWI', 'Meierismør', 40)];
  assert.deepEqual(E.searchTerms({ name: 'k', terms: ['kjottdeig'] }, offers), ['kjøttdeig']);
  assert.deepEqual(E.searchTerms({ name: 's', terms: ['*smor'] }, offers), ['smør']);
  assert.deepEqual(E.searchTerms({ name: 'x', terms: ['ost', 'ab'] }, offers), ['ost']);
});

test('Coop 2-for-110 kjøttdeig wins on unit price and is shown', () => {
  const coop = offer('Extra', 'Coop Kjøttdeig', 110, { size: 400, pieces: 2, desc: '14 %. 400 g\nKun 55,- pr pakke' });
  const kiwi = offer('KIWI', 'KJØTTDEIG 14 % FETT', 79.9, { pre: 89.9, size: 400 });
  const rema = offer('REMA 1000', 'KJØTTDEIG AV STORFE 14%', 64.9, { pre: 78.9, size: 400 });
  const r = E.compute({ offers: [coop, kiwi, rema], trackedItems: [{ id: 'k', name: 'kjottdeig', terms: ['kjottdeig'] }], shopKeys: shops, now: NOW });
  assert.deepEqual(items(r.shops), [['Extra', 'Coop Kjøttdeig']]);
  assert.equal(r.shops[0].items[0].unitPrice, 137.5);
});

test('a dish containing the item (pizza with kjøttdeig) is not a cheaper regular price', () => {
  const coop = offer('Extra', 'Coop Kjøttdeig', 110, { size: 400, pieces: 2 });
  const item = { id: 'k', name: 'kjottdeig', terms: ['kjottdeig'] };
  const pizza = { ...kp('Meny', 'Grandiosa Pizza Kjøttdeig&Løk 520g', 47.34, 520), categories: ['Pizza', 'Pizza', 'Middag'] };
  const mince = { ...kp('Meny', 'Gilde Kjøttdeig 14% 400g', 69.9, 400), categories: ['Kjøttdeig', 'Kjøtt'] };
  const r = E.compute({ offers: [coop], trackedItems: [item], shopKeys: shops, kassal: { k: [pizza, mince] }, now: NOW });
  assert.deepEqual(items(r.shops), [['Extra', 'Coop Kjøttdeig']]);
  assert.match(r.shops[0].items[0].regular.source, /Meny/);

  // A genuinely cheaper regular kjøttdeig elsewhere still drops the offer.
  const cheap = { ...kp('KIWI', 'First Price Kjøttdeig 400g', 49.9, 400), categories: ['Kjøttdeig'] };
  const r2 = E.compute({ offers: [coop], trackedItems: [item], shopKeys: shops, kassal: { k: [pizza, cheap] }, now: NOW });
  assert.equal(r2.shops.length, 0);
  assert.match(r2.dropped[0].reason, /KIWI is lower: 124,75\/kg \(First Price/);
});

test('pack counts are read from the text when the flyer says "1 pcs"', () => {
  const o = offer('X', 'COOP FROKOSTEGG 18 PK', 69.9, { size: 1, unit: 'pcs' });
  assert.deepEqual(E.offerAmount(o), { dim: 'stk', amount: 18 });
  const d = offer('X', 'Libresse', 36.95, { size: 1, unit: 'pcs', desc: '80 stk. Pr pk' });
  assert.deepEqual(E.offerAmount(d), { dim: 'stk', amount: 80 });
  const u = offer('X', 'Coop Frokostegg', 77.9, { size: 1, unit: 'pcs' });
  assert.deepEqual(E.offerAmount(u), { dim: 'pk', amount: 1 });
});

test('exclude terms and untracked items are filtered out', () => {
  const offers = [
    offer('KIWI', 'Tine kryddersmør', 19.9, { pre: 29.9, size: 125 }),
    offer('KIWI', 'Jarlsberg', 59.9, { pre: 79.9 }),
  ];
  const r = E.compute({ offers, trackedItems: [smor], shopKeys: shops, now: NOW });
  assert.equal(r.shops.length, 0);
  assert.equal(r.dropped.length, 0);
});

test('multi-word terms need every word, at least one in the heading', () => {
  const item = { id: 't2', name: 'Tine smør', terms: ['tine *smør'] };
  assert.ok(E.itemMatches(item, 'Meierismør', 'TINE, 500 g'));
  assert.ok(!E.itemMatches(item, 'Meierismør', 'Q, 500 g'));
  assert.ok(!E.itemMatches(item, 'Lettmelk', 'Tine. Husk smør'));
});

test('unit price uses size x pieces and averages size ranges', () => {
  assert.deepEqual(E.offerAmount(offer('X', 'Cola', 250, { size: 0.33, unit: 'l', pieces: 40 })), { dim: 'l', amount: 0.33 * 40 });
  const o = offer('X', 'Pizza', 65, { pieces: 2 });
  o.quantity.size = { from: 300, to: 410 };
  assert.equal(E.offerAmount(o).amount.toFixed(3), '0.710');
});

test('multi-buy offers do not trust per-unit førpris from the description', () => {
  assert.equal(E.offerRegular(offer('X', 'Kjøttdeig', 110, { pieces: 2, desc: 'Førpris 79,90' })), null);
  assert.equal(E.offerRegular(offer('X', 'Pepsi', 119, { pieces: 8, pre: 149 })).price, 149);
});

test('Kassalapp regular price ignores a short campaign in history', () => {
  const p = { current_price: 39.9, price_history: [
    { price: 39.9, date: '2026-11-10' }, { price: 54.9, date: '2026-10-20' },
    { price: 54.9, date: '2026-10-01' }, { price: 54.9, date: '2026-09-15' }] };
  assert.equal(E.regularFromHistory(p, NOW), 54.9);
});

test('different dimensions (kg vs stk) are compared separately', () => {
  const egg = { id: 'e', name: 'Egg', terms: ['egg'] };
  const offers = [
    offer('KIWI', 'Egg 12 stk', 39.9, { pre: 49.9, size: 12, unit: 'pcs' }),
    offer('Extra', 'Egg 690 g', 35.9, { pre: 45.9, size: 690 }),
  ];
  const r = E.compute({ offers, trackedItems: [egg], shopKeys: shops, now: NOW });
  assert.equal(items(r.shops).length, 2);
});

test('end of week is Sunday 23:59:59 Oslo time', () => {
  assert.equal(new Date(E.endOfWeek(NOW)).toISOString(), '2026-11-15T22:59:59.000Z');
  const sunday = Date.parse('2026-11-15T20:00:00Z');
  assert.equal(new Date(E.endOfWeek(sunday)).toISOString(), '2026-11-15T22:59:59.000Z');
});

test('weekly fetch slot is Monday 01:00 Oslo time, DST-aware', () => {
  const iso = (t) => new Date(t).toISOString();
  // Wed 11 Nov 2026 (CET, UTC+1): last = Mon 9 Nov 01:00 = 00:00Z, next = Mon 16 Nov.
  let s = E.fetchSlots(NOW);
  assert.equal(iso(s.last), '2026-11-09T00:00:00.000Z');
  assert.equal(iso(s.next), '2026-11-16T00:00:00.000Z');
  // Monday 00:30 Oslo is before the slot -> still last week's.
  s = E.fetchSlots(Date.parse('2026-11-15T23:30:00Z'));
  assert.equal(iso(s.last), '2026-11-09T00:00:00.000Z');
  // Monday 01:00 Oslo exactly -> this week's slot.
  s = E.fetchSlots(Date.parse('2026-11-16T00:00:00Z'));
  assert.equal(iso(s.last), '2026-11-16T00:00:00.000Z');
  // Summer time (CEST, UTC+2): Mon 15 Jun 2026 01:00 = 14 Jun 23:00Z.
  s = E.fetchSlots(Date.parse('2026-06-17T12:00:00Z'));
  assert.equal(iso(s.last), '2026-06-14T23:00:00.000Z');
  // Across the DST change (29 Mar 2026): next slot after Mon 23 Mar is Mon 30 Mar 01:00 CEST.
  s = E.fetchSlots(Date.parse('2026-03-25T12:00:00Z'));
  assert.equal(iso(s.last), '2026-03-23T00:00:00.000Z');
  assert.equal(iso(s.next), '2026-03-29T23:00:00.000Z');
});

test('a shown deal carries its flyer link (null when the offer has none)', () => {
  const linked = { ...offer('KIWI', 'Smør', 39.9, { pre: 59.9 }), url: 'https://etilbudsavis.no/KIWI?offer=x' };
  let r = E.compute({ offers: [linked], trackedItems: [smor], shopKeys: shops, now: NOW });
  assert.equal(r.shops[0].items[0].url, 'https://etilbudsavis.no/KIWI?offer=x');
  r = E.compute({ offers: [offer('KIWI', 'Smør', 39.9, { pre: 59.9 })], trackedItems: [smor], shopKeys: shops, now: NOW });
  assert.equal(r.shops[0].items[0].url, null);
});

test('a dropped offer carries the details needed to show it', () => {
  const loser = { ...offer('KIWI', 'Meierismør', 49.9, { pre: 72.9, desc: 'Tine, 500 g' }), url: 'https://etilbudsavis.no/KIWI?offer=y' };
  const winner = offer('REMA 1000', 'Smør', 39.9, { pre: 69.9 });
  const noRef = offer('Extra', 'Smør', 20, { size: 250 });  // cheapest per kg in its own right? 80/kg vs 79.8 -> loses
  const r = E.compute({ offers: [loser, winner, noRef], trackedItems: [smor], shopKeys: shops, now: NOW });
  const d = r.dropped.find((x) => x.shop === 'KIWI');
  assert.equal(d.id, loser.id);
  assert.equal(d.url, 'https://etilbudsavis.no/KIWI?offer=y');
  assert.equal(d.description, 'Tine, 500 g');
  assert.equal(d.unit, 'kg');
  assert.equal(d.unitPrice.toFixed(2), '99.80');
  assert.deepEqual(d.regular, { price: 72.9, unitPrice: 72.9 / 0.5, source: 'Førpris in flyer' });
  assert.equal(d.runTill, loser.run_till);
  assert.match(d.reason, /Cheaper at REMA 1000/);
  // An offer with no flyer regular price has regular: null (not undefined).
  assert.equal(r.dropped.find((x) => x.shop === 'Extra').regular, null);
});

test('isThisWeek gives the same answer with a precomputed week end', () => {
  const end = E.endOfWeek(NOW);
  const cases = [
    ['2026-11-09T00:00:00+0000', '2026-11-15T22:59:59+0000'],  // this week
    ['2026-11-01T00:00:00+0000', '2026-11-10T00:00:00+0000'],  // already ended
    ['2026-11-16T00:00:00+0000', '2026-11-22T00:00:00+0000'],  // starts next week
    ['2026-11-13T00:00:00+0000', '2026-11-20T00:00:00+0000'],  // starts later this week
  ];
  const got = cases.map(([run_from, run_till]) => [E.isThisWeek({ run_from, run_till }, NOW), E.isThisWeek({ run_from, run_till }, NOW, end)]);
  assert.deepEqual(got, [[true, true], [false, false], [false, false], [true, true]]);
});

test('editing an item (a new object) is matched with its new terms', () => {
  const before = { id: 'x', name: 'X', terms: ['smør'] };
  assert.ok(E.itemMatches(before, 'Smør', ''));
  const after = { ...before, terms: ['ost'], exclude: ['smør'] };
  assert.ok(!E.itemMatches(after, 'Smør', ''));
  assert.ok(E.itemMatches(after, 'Ost', ''));
  assert.ok(E.itemMatches(before, 'Smør', ''));
});

test('shop keys line up across sources', () => {
  assert.equal(E.shopKey('Coop Extra'), E.shopKey('Extra'));
  assert.equal(E.shopKey('Coop Obs'), E.shopKey('Obs'));
  assert.equal(E.shopKey('Rema 1000'), E.shopKey('REMA 1000'));
});
