'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../lib/app');
const { memoryStore } = require('../lib/store');

const ORIGIN = 'http://tilbud.test';
const quiet = () => {};

function setup(env = {}, store = memoryStore()) {
  const app = createApp({ store, env: { DISABLE_FETCH: '1', ...env }, log: quiet });
  // A tiny client with a cookie jar, like one browser.
  function client(cookie = '') {
    const call = async function (method, path, body, headers = {}) {
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      if (body !== undefined) { h['content-type'] ??= 'application/json'; h.origin ??= ORIGIN; }
      const res = await app.handle(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
      const set = res.headers.get('set-cookie');
      if (set) {
        const v = set.split(';')[0];
        cookie = v.endsWith('=') ? '' : v;
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    };
    call.cookie = () => cookie;
    return call;
  }
  return { app, store, client };
}

test('a new browser gets an empty list and no cookie until it saves something', async () => {
  const { client, store } = setup();
  const r = await client()('GET', '/api/state');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.settings.trackedItems, []);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.deepEqual(await store.list('visitors/'), []);
});

test('saving an item sets a long-lived HttpOnly cookie that brings the list back', async () => {
  const { client } = setup();
  const call = client();
  const r = await call('POST', '/api/items', { name: 'Smør', terms: 'smør, *smør' });
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /^tt_visitor=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=34560000$/);
  // Same browser later (or another tab): same list.
  const again = client(call.cookie());
  assert.deepEqual((await again('GET', '/api/state')).body.settings.trackedItems.map((i) => i.name), ['Smør']);
});

test('cookie gets Secure over https', async () => {
  const { app } = setup();
  const res = await app.handle(new Request('https://x.test/api/items', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://x.test' },
    body: JSON.stringify({ name: 'Egg' }),
  }));
  assert.match(res.headers.get('set-cookie'), /; Secure$/);
});

test('each browser has its own list', async () => {
  const { client } = setup();
  const a = client(), b = client();
  const added = await a('POST', '/api/items', { name: 'Smør' });
  await b('POST', '/api/items', { name: 'Egg' });
  assert.deepEqual((await a('GET', '/api/state')).body.settings.trackedItems.map((i) => i.name), ['Smør']);
  assert.deepEqual((await b('GET', '/api/state')).body.settings.trackedItems.map((i) => i.name), ['Egg']);
  // B cannot edit or delete A's item, even knowing its id.
  const id = added.body.settings.trackedItems[0].id;
  assert.equal((await b('PUT', `/api/items/${id}`, { name: 'x' })).status, 404);
  await b('POST', '/api/items/delete', { ids: [id] });
  assert.equal((await a('GET', '/api/state')).body.settings.trackedItems.length, 1);
});

test('the store keeps only a hash of the cookie, and a made-up cookie gets an empty list', async () => {
  const { client, store } = setup();
  const call = client();
  await call('POST', '/api/items', { name: 'Egg' });
  const token = call.cookie().split('=')[1];
  const keys = await store.list('visitors/');
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes(token));
  const guess = client('tt_visitor=' + 'A'.repeat(43));
  assert.deepEqual((await guess('GET', '/api/state')).body.settings.trackedItems, []);
});

test('mutating routes need JSON and a same-origin Origin', async () => {
  const { client } = setup();
  const call = client();
  assert.equal((await call('POST', '/api/items', { name: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call('POST', '/api/items', { name: 'x' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal(call.cookie(), '', 'nothing saved');
});

test('shared settings need ADMIN_CODE, and are locked without one', async () => {
  const locked = setup().client();
  assert.equal((await locked('PUT', '/api/settings', { shops: [], adminCode: '' })).status, 403);

  const { client } = setup({ ADMIN_CODE: 'open-sesame' });
  const a = client(), b = client();
  assert.equal((await a('PUT', '/api/settings', { shops: [] })).status, 403);
  assert.equal((await a('PUT', '/api/settings', { shops: [], adminCode: 'nope' })).status, 403);
  const r = await a('PUT', '/api/settings', { shops: ['257bxm'], adminCode: 'open-sesame' });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.adminCodeSet, true);
  assert.deepEqual((await b('GET', '/api/state')).body.settings.shops, ['257bxm'], 'shared by everyone');
});

test('wrong admin codes are throttled', async () => {
  const { client } = setup({ ADMIN_CODE: 'open-sesame' });
  const call = client();
  for (let i = 0; i < 10; i++) assert.equal((await call('PUT', '/api/settings', { shops: [], adminCode: 'guess' + i })).status, 403);
  assert.equal((await call('PUT', '/api/settings', { shops: [], adminCode: 'open-sesame' })).status, 429);
});

test('the Kassalapp key and admin code are never returned', async () => {
  const { client } = setup({ KASSAL_KEY: 'super-secret-key', ADMIN_CODE: 'open-sesame' });
  const r = await client()('GET', '/api/state');
  assert.equal(r.body.settings.kassalKeySet, true);
  assert.ok(!JSON.stringify(r.body).includes('super-secret-key'));
  assert.ok(!JSON.stringify(r.body).includes('open-sesame'));
});

test('state sends an ETag and answers 304 when unchanged', async () => {
  const { client } = setup();
  const call = client();
  await call('POST', '/api/items', { name: 'Egg' });
  const r = await call('GET', '/api/state');
  const etag = r.headers.get('etag');
  assert.ok(etag);
  assert.equal((await call('GET', '/api/state', undefined, { 'if-none-match': `W/${etag}` })).status, 304);
  await call('POST', '/api/items', { name: 'Melk' });
  assert.equal((await call('GET', '/api/state', undefined, { 'if-none-match': etag })).status, 200);
});

// ---- refresh (external APIs stubbed) ----
const tjek = require('../lib/tjek');
const kassal = require('../lib/kassal');

function stubApis(t, { fetchMs = 0 } = {}) {
  const calls = { offers: [], kassal: [] };
  const now = Date.now();
  t.mock.method(tjek, 'fetchDealerOffers', async (id) => {
    calls.offers.push(id);
    if (fetchMs) await new Promise((r) => setTimeout(r, fetchMs));
    return [{ id: `o-${id}`, heading: 'Tine Smør', description: '500 g', pricing: { price: 50, pre_price: 70 }, quantity: { unit: { symbol: 'g' }, size: { from: 500, to: 500 }, pieces: { from: 1, to: 1 } },
      images: {}, run_from: new Date(now - 864e5).toISOString(), run_till: new Date(now + 864e5).toISOString(), dealer_id: id, dealer: { name: 'KIWI', markets: [] } }];
  });
  t.mock.method(tjek, 'discoverDealers', async () => []);
  t.mock.method(kassal, 'productsForTerms', async (key, terms) => { calls.kassal.push(terms); return []; });
  return calls;
}

test('work() fetches each shop once per week and resumes after a time budget', async (t) => {
  const calls = stubApis(t, { fetchMs: 30 });
  const store = memoryStore();
  await store.set('settings', { shops: ['257bxm', 'faa0Ym', '4333pm'] });
  const app = createApp({ store, env: {}, log: quiet });
  await app.work({ budgetMs: 40 });  // time for about two shops
  assert.ok(calls.offers.length < 3, `stopped early (${calls.offers.length})`);
  await app.work();
  assert.deepEqual([...calls.offers].sort(), ['257bxm', '4333pm', 'faa0Ym']);
  await app.work();
  assert.equal(calls.offers.length, 3, 'no refetch within the week');
});

test('Kassalapp lookups are shared between browsers tracking the same thing', async (t) => {
  const calls = stubApis(t);
  const store = memoryStore();
  await store.set('settings', { shops: ['257bxm'], kassalKey: 'k' });
  const app = createApp({ store, env: {}, log: quiet });
  const req = (path, body, cookie) => new Request(ORIGIN + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const bg = [];
  const opts = { background: (p) => bg.push(p) };
  for (let n = 0; n < 2; n++) {  // two browsers
    await app.handle(req('/api/items', { name: 'Smør' }), opts);
    await Promise.all(bg);
  }
  await app.work();
  assert.equal(calls.kassal.length, 1, JSON.stringify(calls.kassal));
});
