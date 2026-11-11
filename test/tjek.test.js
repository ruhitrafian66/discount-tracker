'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { offerUrl, slim } = require('../lib/tjek');

const raw = (over = {}) => ({
  id: 'ghvjktAxv0xuv43NPvkVo', catalog_id: 'JuJgOIGV', heading: 'Coop Kjøttdeig', description: '',
  pricing: { price: 110, pre_price: null }, quantity: {}, images: { thumb: 't' },
  run_from: 'a', run_till: 'b', dealer_id: '80742m',
  dealer: { name: 'Extra', logo: 'l', color: 'c', markets: [{ slug: 'Extra', country_code: 'NO' }] },
  ...over,
});

test('offer link uses the dealer market slug, publication and offer id', () => {
  assert.equal(offerUrl(raw()), 'https://etilbudsavis.no/Extra?publication=JuJgOIGV&offer=ghvjktAxv0xuv43NPvkVo');
  const rema = raw({ dealer: { name: 'REMA 1000', markets: [{ slug: 'REMA-1000', country_code: 'NO' }] } });
  assert.match(offerUrl(rema), /^https:\/\/etilbudsavis\.no\/REMA-1000\?/);
});

test('offer link prefers the Norwegian market and works without a catalog', () => {
  const multi = raw({ catalog_id: null, dealer: { name: 'X', markets: [{ slug: 'X-dk', country_code: 'DK' }, { slug: 'X-no', country_code: 'NO' }] } });
  assert.equal(offerUrl(multi), 'https://etilbudsavis.no/X-no?offer=ghvjktAxv0xuv43NPvkVo');
});

test('no link when the dealer has no slug (a guessed slug would 404)', () => {
  assert.equal(offerUrl(raw({ dealer: { name: 'Extra', markets: [] } })), null);
  assert.equal(offerUrl(raw({ dealer: { name: 'Extra' } })), null);
});

test('slim keeps the link and drops the bulky fields', () => {
  const s = slim(raw());
  assert.equal(s.url, 'https://etilbudsavis.no/Extra?publication=JuJgOIGV&offer=ghvjktAxv0xuv43NPvkVo');
  assert.equal(s.dealer.markets, undefined);
});
