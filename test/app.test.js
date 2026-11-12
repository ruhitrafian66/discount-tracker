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

test('anonymous state has no user data and says whether a sign-up code is needed', async () => {
  const { client } = setup({ SIGNUP_CODE: 'secret' });
  const r = await client()('GET', '/api/state');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { user: null, signup: { codeRequired: true } });
});

test('register sets an HttpOnly session cookie and logs in', async () => {
  const { client } = setup();
  const call = client();
  const r = await call('POST', '/api/auth/register', { username: 'Alice', password: 'correct horse' });
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /^tt_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  assert.equal(r.body.user.name, 'alice');
  assert.equal(r.body.user.admin, true, 'first account is admin when ADMINS is unset');
  const s = await call('GET', '/api/state');
  assert.equal(s.body.user.name, 'alice');
});

test('cookie gets Secure over https', async () => {
  const { app } = setup();
  const res = await app.handle(new Request('https://x.test/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://x.test' },
    body: JSON.stringify({ username: 'bob', password: '12345678' }),
  }));
  assert.match(res.headers.get('set-cookie'), /; Secure$/);
});

test('tracked items are per account', async () => {
  const { client } = setup();
  const a = client(), b = client();
  await a('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  await b('POST', '/api/auth/register', { username: 'bob', password: 'password2' });
  const added = await a('POST', '/api/items', { name: 'Smør', terms: 'smør, *smør' });
  assert.equal(added.status, 201);
  assert.equal((await a('GET', '/api/state')).body.settings.trackedItems.length, 1);
  assert.equal((await b('GET', '/api/state')).body.settings.trackedItems.length, 0);
  // Bob cannot edit or delete Alice's item.
  const id = added.body.settings.trackedItems[0].id;
  assert.equal((await b('PUT', `/api/items/${id}`, { name: 'x' })).status, 404);
  await b('POST', '/api/items/delete', { ids: [id] });
  assert.equal((await a('GET', '/api/state')).body.settings.trackedItems.length, 1);
});

test('items survive logout and come back on login from another device', async () => {
  const { client } = setup();
  const phone = client(), laptop = client();
  await phone('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  await phone('POST', '/api/items', { name: 'Egg' });
  const out = await phone('POST', '/api/auth/logout', {});
  assert.equal(out.body.user, null);
  assert.equal((await phone('GET', '/api/items/delete')).status, 401);
  assert.equal((await laptop('POST', '/api/auth/login', { username: 'alice', password: 'wrong-pass' })).status, 401);
  const r = await laptop('POST', '/api/auth/login', { username: 'ALICE', password: 'password1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.settings.trackedItems.map((i) => i.name), ['Egg']);
});

test('logout revokes the session server-side', async () => {
  const { client } = setup();
  const call = client();
  await call('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  // A copy of the cookie (another tab, or a stolen one) must stop working too.
  const copy = client(call.cookie());
  assert.equal((await copy('GET', '/api/state')).body.user.name, 'alice');
  await call('POST', '/api/auth/logout', {});
  assert.equal((await call('GET', '/api/state')).body.user, null);
  assert.equal((await copy('GET', '/api/state')).body.user, null);
});

test('mutating routes need a login, JSON and a same-origin Origin', async () => {
  const { client } = setup();
  const call = client();
  assert.equal((await call('POST', '/api/items', { name: 'x' })).status, 401);
  await call('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  assert.equal((await call('POST', '/api/items', { name: 'x' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call('POST', '/api/items', { name: 'x' }, { origin: 'https://evil.test' })).status, 403);
  // Login is a write too: a cross-site page cannot log you in to its account.
  assert.equal((await client()('POST', '/api/auth/login', { username: 'alice', password: 'password1' }, { origin: 'https://evil.test' })).status, 403);
});

test('sign-up code, username rules and duplicates', async () => {
  const { client } = setup({ SIGNUP_CODE: 'letmein' });
  const call = client();
  assert.equal((await call('POST', '/api/auth/register', { username: 'alice', password: 'password1' })).status, 403);
  assert.equal((await call('POST', '/api/auth/register', { username: 'alice', password: 'password1', code: 'nope' })).status, 403);
  assert.equal((await call('POST', '/api/auth/register', { username: 'a', password: 'password1', code: 'letmein' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { username: 'alice', password: 'short', code: 'letmein' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { username: 'alice', password: 'password1', code: 'letmein' })).status, 201);
  assert.equal((await client()('POST', '/api/auth/register', { username: 'Alice', password: 'password1', code: 'letmein' })).status, 409);
});

test('only admins change shared settings; ADMINS overrides first-user', async () => {
  const { client } = setup({ ADMINS: 'bob' });
  const a = client(), b = client();
  await a('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  await b('POST', '/api/auth/register', { username: 'bob', password: 'password2' });
  assert.equal((await a('PUT', '/api/settings', { shops: [] })).status, 403);
  const r = await b('PUT', '/api/settings', { shops: ['257bxm'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.settings.shops, ['257bxm']);
  assert.deepEqual((await a('GET', '/api/state')).body.settings.shops, ['257bxm'], 'shared by everyone');
});

test('the Kassalapp key is never returned', async () => {
  const { client } = setup({ KASSAL_KEY: 'super-secret-key' });
  const call = client();
  const r = await call('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  assert.equal(r.body.settings.kassalKeySet, true);
  assert.ok(!JSON.stringify(r.body).includes('super-secret-key'));
});

test('change password', async () => {
  const { client } = setup();
  const call = client();
  await call('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  assert.equal((await call('POST', '/api/auth/password', { current: 'wrong-one', next: 'password2' })).status, 403);
  assert.equal((await call('POST', '/api/auth/password', { current: 'password1', next: 'password2' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'alice', password: 'password1' })).status, 401);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'alice', password: 'password2' })).status, 200);
});

test('repeated wrong passwords are throttled', async () => {
  const { client } = setup();
  await client()('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  const call = client();
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'guess' + i })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'password1' })).status, 429);
});

test('the first account inherits items tracked before accounts existed', async () => {
  const store = memoryStore();
  await store.set('settings', { trackedItems: [{ id: 'old-1', name: 'Kaffe', terms: ['kaffe'], exclude: [] }] });
  const { client } = setup({}, store);
  const r = await client()('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  assert.deepEqual(r.body.settings.trackedItems.map((i) => i.name), ['Kaffe']);
  assert.equal((await store.get('settings')).trackedItems, undefined);
  const r2 = await client()('POST', '/api/auth/register', { username: 'bob', password: 'password2' });
  assert.equal(r2.body.settings.trackedItems.length, 0);
});

test('state sends an ETag and answers 304 when unchanged', async () => {
  const { client } = setup();
  const call = client();
  await call('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  const r = await call('GET', '/api/state');
  const etag = r.headers.get('etag');
  assert.ok(etag);
  assert.equal((await call('GET', '/api/state', undefined, { 'if-none-match': `W/${etag}` })).status, 304);
  await call('POST', '/api/items', { name: 'Egg' });
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

test('Kassalapp lookups are shared between users tracking the same thing', async (t) => {
  const calls = stubApis(t);
  const store = memoryStore();
  await store.set('settings', { shops: ['257bxm'], kassalKey: 'k' });
  const app = createApp({ store, env: {}, log: quiet });
  const req = (path, body, cookie) => new Request(ORIGIN + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const bg = [];
  const opts = { background: (p) => bg.push(p) };
  for (const name of ['alice', 'bob']) {
    const r = await app.handle(req('/api/auth/register', { username: name, password: 'password1' }), opts);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    await app.handle(req('/api/items', { name: 'Smør' }, cookie), opts);
    await Promise.all(bg);
  }
  await app.work();
  assert.equal(calls.kassal.length, 1, JSON.stringify(calls.kassal));
});
