'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { memoryStore, fileStore } = require('../lib/store');
const engine = require('../lib/engine');

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
  const bergen = { name: 'Bergen', lat: 60.3913, lng: 5.3221, radiusKm: 10 };
  assert.equal((await a('PUT', '/api/settings', { location: bergen })).status, 403);
  assert.equal((await a('PUT', '/api/settings', { location: bergen, adminCode: 'nope' })).status, 403);
  const r = await a('PUT', '/api/settings', { location: bergen, adminCode: 'open-sesame' });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.adminCodeSet, true);
  assert.equal((await b('GET', '/api/state')).body.settings.location.name, 'Bergen', 'shared by everyone');
});

test('nobody can set the Kassalapp key through the API, not even with the admin code', async () => {
  const { client, store } = setup({ ADMIN_CODE: 'open-sesame' });
  const call = client();
  const r = await call('PUT', '/api/settings', { kassalKey: 'attacker-key', adminCode: 'open-sesame' });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.kassalKeySet, false);
  assert.ok(!((await store.get('settings')) || {}).kassalKey, 'no key stored');
});

test('each browser picks its own shops, without the admin code', async () => {
  const { client, store } = setup({ ADMIN_CODE: 'open-sesame' });
  const a = client(), b = client();
  const all = (await a('GET', '/api/state')).body.settings.shops;
  assert.equal(all.length, 13, 'default: every grocery chain');
  const r = await a('PUT', '/api/shops', { shops: ['257bxm', 'faa0Ym', 'not-a-shop'] });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /^tt_visitor=/);
  assert.deepEqual(r.body.settings.shops, ['257bxm', 'faa0Ym'], 'unknown ids dropped');
  assert.deepEqual((await a('GET', '/api/state')).body.settings.shops, ['257bxm', 'faa0Ym']);
  assert.equal((await b('GET', '/api/state')).body.settings.shops.length, 13, 'others keep the default');
  // Shared settings no longer change shops.
  await a('PUT', '/api/settings', { shops: [], adminCode: 'open-sesame' });
  assert.equal((await store.get('settings')).shops.length, 13, 'default list unchanged');
  assert.equal((await b('GET', '/api/state')).body.settings.shops.length, 13);
  // Same CSRF guard as other writes.
  assert.equal((await b('PUT', '/api/shops', { shops: [] }, { origin: 'https://evil.test' })).status, 403);
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
  // Every grocery chain is fetched (anyone may pick any of them): 13 shops.
  await app.work({ budgetMs: 40 });  // time for about two shops
  assert.ok(calls.offers.length < 13, `stopped early (${calls.offers.length})`);
  await app.work();
  assert.equal(new Set(calls.offers).size, 13);
  assert.equal(calls.offers.length, 13, 'each shop once');
  await app.work();
  assert.equal(calls.offers.length, 13, 'no refetch within the week');
});

test('picking a chain that is not fetched yet adds it to the fetch; browse shows only my shops', async (t) => {
  const calls = stubApis(t);
  t.mock.method(tjek, 'discoverDealers', async () => [{ id: 'jula01', name: 'Jula' }]);
  const store = memoryStore();
  await store.set('settings', { shops: ['257bxm'] });
  const app = createApp({ store, env: {}, log: quiet });
  await app.work();
  assert.ok(!calls.offers.includes('jula01'));
  const bg = [];
  const req = (method, path, body, cookie) => new Request(ORIGIN + path, { method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  const r = await app.handle(req('PUT', '/api/shops', { shops: ['jula01'] }), { background: (p) => bg.push(p) });
  await Promise.all(bg);
  assert.ok(calls.offers.includes('jula01'), 'fetched off-schedule, once');
  assert.deepEqual((await store.get('flags')).wantedShops, ['jula01']);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const browse = await (await app.handle(new Request(ORIGIN + '/api/offers', { headers: { cookie } }))).json();
  assert.equal(browse.offers.length, 1, 'only the offer from my one shop');
});

test('browse: ?shops= narrows the list to some of my shops, never to a shop that is not mine', async (t) => {
  stubApis(t);
  const store = memoryStore();
  await store.set('settings', { shops: ['257bxm', 'faa0Ym', '4333pm'] });
  const app = createApp({ store, env: {}, log: quiet });
  await app.work();  // every grocery chain is fetched, one offer each
  const browse = async (query) => {
    const r = await (await app.handle(new Request(ORIGIN + '/api/offers' + query))).json();
    return [r.offers.map((o) => o.id), r.shops.map((s) => `${s.id} ${s.count}`)];
  };
  const mine = ['257bxm 1', 'faa0Ym 1', '4333pm 1'];
  assert.deepEqual(await browse(''), [['o-257bxm', 'o-faa0Ym', 'o-4333pm'], mine]);
  assert.deepEqual(await browse('?shops=faa0Ym'), [['o-faa0Ym'], mine]);
  assert.deepEqual(await browse('?q=tine&shops=4333pm,257bxm'), [['o-257bxm', 'o-4333pm'], mine]);
  // Bunnpris is fetched too, but is not one of this browser's shops: ignored.
  assert.deepEqual(await browse('?shops=5b11sm'), [['o-257bxm', 'o-faa0Ym', 'o-4333pm'], mine]);
  assert.deepEqual(await browse('?q=egg&shops=faa0Ym'), [[], ['257bxm 0', 'faa0Ym 0', '4333pm 0']]);
});

test('Kassalapp lookups are shared between browsers tracking the same thing', async (t) => {
  const calls = stubApis(t);
  const store = memoryStore();
  await store.set('settings', { shops: ['257bxm'] });
  const app = createApp({ store, env: { KASSAL_KEY: 'k' }, log: quiet });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body, cookie, method = 'POST') => new Request(ORIGIN + path, {
  method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

test('an item saved during a refresh is looked up when that refresh ends, not at the next run', async (t) => {
  const calls = stubApis(t);
  let started = 0;
  t.mock.method(kassal, 'productsForTerms', async (key, terms) => { started++; await sleep(40); calls.kassal.push(terms); return []; });
  const app = createApp({ store: memoryStore(), env: { KASSAL_KEY: 'k' }, log: quiet });
  const bg = [];
  const opts = { background: (p) => bg.push(p) };
  const first = await app.handle(post('/api/items', { name: 'Melk' }), opts);
  for (let i = 0; i < 200 && !started; i++) await sleep(5);
  assert.equal(started, 1, 'the lookup for the first item is running');
  await app.handle(post('/api/items', { name: 'Smør' }, cookieOf(first)), opts);
  await Promise.all(bg);
  assert.deepEqual(calls.kassal, [['melk'], ['smør']]);
  assert.equal(calls.offers.length, 13, 'the extra pass fetches no offers again');
});

test('the offer count covers only my shops', async (t) => {
  stubApis(t);  // one offer per shop
  const app = createApp({ store: memoryStore(), env: {}, log: quiet });
  await app.work();
  const all = await (await app.handle(new Request(ORIGIN + '/api/state'))).json();
  assert.equal(all.status.offerCount, 13);
  const mine = await (await app.handle(post('/api/shops', { shops: ['257bxm', 'faa0Ym'] }, null, 'PUT'))).json();
  assert.equal(mine.status.offerCount, 2);
});

test('the Kassalapp key is KASSAL_KEY only: one stored in the settings is ignored', async (t) => {
  const calls = stubApis(t);
  const store = memoryStore();
  await store.set('settings', { kassalKey: 'left-over' });
  const app = createApp({ store, env: {}, log: quiet });
  const bg = [];
  const r = await app.handle(post('/api/items', { name: 'Smør' }), { background: (p) => bg.push(p) });
  assert.equal((await r.json()).settings.kassalKeySet, false);
  assert.equal(bg.length, 0, 'no key: saving an item starts no refresh');
  await app.work();
  assert.deepEqual(calls.kassal, []);
});

test('a rejected Kassalapp key stops lookups until the key is replaced', async (t) => {
  stubApis(t);
  const keys = [];
  t.mock.method(kassal, 'productsForTerms', async (key) => {
    keys.push(key);
    if (key === 'bad') throw Object.assign(new Error('Kassalapp HTTP 401'), { status: 401 });
    return [];
  });
  const store = memoryStore();
  const state = async (app) => (await (await app.handle(new Request(ORIGIN + '/api/state'))).json()).status;
  const bad = createApp({ store, env: { KASSAL_KEY: 'bad' }, log: quiet });
  const bg = [];
  await bad.handle(post('/api/items', { name: 'Smør' }), { background: (p) => bg.push(p) });
  await Promise.all(bg);
  await bad.work();
  assert.deepEqual(keys, ['bad'], 'asked once, not again on the next run');
  assert.match((await state(bad)).kassalError, /401/);
  assert.equal((await state(bad)).kassalRefreshing, false);
  // The key is fixed in the environment: a new instance looks the item up right away.
  const good = createApp({ store, env: { KASSAL_KEY: 'good' }, log: quiet });
  assert.equal((await state(good)).kassalRefreshing, true);
  await good.work();
  assert.deepEqual(keys, ['bad', 'good']);
  assert.equal((await state(good)).kassalError, null);
});

// A memory store that hands out ETags and answers "unchanged", as Netlify Blobs does.
function versionedStore() {
  const inner = memoryStore(), ver = new Map();
  const tag = (key) => (ver.has(key) ? `v${ver.get(key)}` : undefined);
  const s = {
    ...inner, downloads: [], delayMs: 0,
    async set(key, value) { await inner.set(key, value); ver.set(key, (ver.get(key) || 0) + 1); return { etag: tag(key) }; },
    async getIfChanged(key, etag) {
      if (s.delayMs) await sleep(s.delayMs);
      if (etag && etag === tag(key)) return { unchanged: true };
      s.downloads.push(key);
      return { value: structuredClone(await inner.get(key)), etag: tag(key) };  // a fresh object each time, like a download
    },
  };
  return s;
}
const bergen = { name: 'Bergen', lat: 60.3913, lng: 5.3221, radiusKm: 10 };

test('shared data that did not change is neither downloaded nor recomputed again', async (t) => {
  const store = versionedStore();
  await store.set('settings', { shops: ['257bxm'] });
  const compute = t.mock.method(engine, 'compute');
  const app = createApp({ store, env: { DISABLE_FETCH: '1' }, globalTtlMs: 0, log: quiet });  // checks the store on every request
  const get = async () => (await app.handle(new Request(ORIGIN + '/api/state'))).json();
  await get(); await get(); await get();
  assert.equal(store.downloads.filter((k) => k === 'settings').length, 1);
  assert.equal(compute.mock.callCount(), 1);
  // Another instance changes the location: the next request has it.
  await store.set('settings', { shops: ['257bxm'], location: bergen });
  assert.equal((await get()).settings.location.name, 'Bergen');
  assert.equal(store.downloads.filter((k) => k === 'settings').length, 2);
  assert.equal(compute.mock.callCount(), 2);
});

test('a save made here is not downloaded again afterwards', async () => {
  const store = versionedStore();
  const app = createApp({ store, env: { DISABLE_FETCH: '1', ADMIN_CODE: 'open-sesame' }, globalTtlMs: 0, log: quiet });
  const r = await app.handle(post('/api/settings', { location: bergen, adminCode: 'open-sesame' }, null, 'PUT'));
  assert.equal(r.status, 200);
  store.downloads.length = 0;
  const s = await (await app.handle(new Request(ORIGIN + '/api/state'))).json();
  assert.equal(s.settings.location.name, 'Bergen');
  assert.deepEqual(store.downloads.filter((k) => k === 'settings'), []);
});

test('within the stale window a request is answered from memory while the store is checked', async () => {
  const store = versionedStore();
  await store.set('settings', { shops: ['257bxm'] });
  const app = createApp({ store, env: { DISABLE_FETCH: '1' }, globalTtlMs: 0, globalMaxStaleMs: 60e3, log: quiet });
  const bg = [];
  const get = async () => (await app.handle(new Request(ORIGIN + '/api/state'), { background: (p) => bg.push(p) })).json();
  assert.equal((await get()).settings.location.name, 'Oslo');  // first load waits for the store
  await Promise.all(bg);
  bg.length = 0;
  await store.set('settings', { shops: ['257bxm'], location: bergen });
  store.delayMs = 50;
  assert.equal((await get()).settings.location.name, 'Oslo', 'answered from memory');
  assert.equal(bg.length, 1, 'the check is handed to the host to finish');
  await Promise.all(bg);
  assert.equal((await get()).settings.location.name, 'Bergen');
});

test('file store: writes to one key at the same time all land, and the last one wins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tilbud-store-'));
  try {
    const store = fileStore(dir);
    const doc = (n) => ({ n, pad: 'x'.repeat(n * 40) });
    await Promise.all(Array.from({ length: 25 }, (_, n) => store.set('visitors/abc', doc(n))));
    assert.deepEqual(await store.get('visitors/abc'), doc(24));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'visitors/abc.json'), 'utf8')), doc(24));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'visitors')), ['abc.json'], 'no temp files left');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
