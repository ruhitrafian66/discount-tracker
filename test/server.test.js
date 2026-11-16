'use strict';
// server.js over HTTP, with a throwaway data directory and no calls to the external APIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tilbud-test-'));
const DATA_DIR = tmpDir();
process.env.DATA_DIR = DATA_DIR;
process.env.DISABLE_FETCH = '1';

// The Pi build keeps one shared list in settings.json. The Netlify build (lib/app.js)
// keeps a list per browser; its storage and refresh are tested in app.test.js.
const PI_BUILD = !fs.existsSync(path.join(__dirname, '../lib/app.js'));
const piOnly = { skip: PI_BUILD ? false : 'Pi build only' };

// Two shops with offers for the Browse test, valid whenever the tests run. The server
// reads the file when it starts. (The Netlify build stores offers in another shape; its
// Browse route is tested in app.test.js.)
const browseOffer = (id, dealer_id, shop, heading) => ({
  id, heading, description: '', pricing: { price: 10, pre_price: null }, dealer_id, dealer: { name: shop, logo: '', color: '' },
  quantity: { unit: { symbol: 'g' }, size: { from: 500, to: 500 }, pieces: { from: 1, to: 1 } }, images: { thumb: '' },
  run_from: new Date(Date.now() - 86400e3).toISOString(), run_till: new Date(Date.now() + 86400e3).toISOString(),
});
if (PI_BUILD) fs.writeFileSync(path.join(DATA_DIR, 'offers.json'), JSON.stringify({ v: 2, fetchedAt: Date.now(), locKey: '', discovered: [], errors: [], byDealer: {
  '257bxm': [browseOffer('a', '257bxm', 'KIWI', 'Smør'), browseOffer('b', '257bxm', 'KIWI', 'Egg')],
  faa0Ym: [browseOffer('c', 'faa0Ym', 'REMA 1000', 'Meierismør')],
} }));

const { server } = require('../server');
const tjek = require('../lib/tjek');

let base;
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => {
  server.close();
  server.closeAllConnections();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const send = (method, p, body, headers = {}) => fetch(base + p, {
  method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const state = async () => (await fetch(base + '/api/state')).json();
const names = async () => (await state()).settings.trackedItems.map((i) => i.name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('serves the page and the state', async () => {
  assert.match(await (await fetch(base + '/')).text(), /Tilbud Tracker/);
  assert.deepEqual((await state()).settings.trackedItems, []);
});

test('saves arriving at the same time all succeed', async () => {
  const res = await Promise.all(Array.from({ length: 30 }, (_, n) => send('POST', '/api/items', { name: `parallel ${n}`, terms: 'x'.repeat(3 + (n * 7) % 40) })));
  assert.deepEqual([...new Set(res.map((r) => r.status))], [201]);
});

test('every one of those saves is kept, in memory and on disk', piOnly, async () => {
  const kept = await names();
  for (let n = 0; n < 30; n++) assert.ok(kept.includes(`parallel ${n}`), `parallel ${n}`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8')).trackedItems.map((i) => i.name);
  assert.deepEqual(onDisk, kept);
  assert.deepEqual(fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');
});

test('a write that fails changes nothing, and the next one works', piOnly, async () => {
  const file = path.join(DATA_DIR, 'settings.json');
  const before = await names();
  const content = fs.readFileSync(file);
  // A directory in the file's place makes the final rename fail, also for root.
  fs.rmSync(file);
  fs.mkdirSync(file);
  const failed = await send('POST', '/api/items', { name: 'not saved' });
  assert.equal(failed.status, 500);
  assert.deepEqual(await names(), before);
  fs.rmdirSync(file);
  fs.writeFileSync(file, content);
  assert.equal((await send('POST', '/api/items', { name: 'saved after' })).status, 201);
  const after = await names();
  assert.ok(after.includes('saved after'));
  assert.ok(!after.includes('not saved'), 'the failed item did not linger in memory');
  assert.deepEqual(fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');
});

test('Browse lists the offers, and ?shops= narrows them to those shops', piOnly, async () => {
  const browse = async (query) => {
    const r = await (await fetch(base + '/api/offers' + query)).json();
    return [r.offers.map((o) => o.heading), r.shops.map((s) => `${s.name} ${s.count}`)];
  };
  assert.deepEqual(await browse(''), [['Egg', 'Meierismør', 'Smør'], ['KIWI 2', 'REMA 1000 1']]);
  assert.deepEqual(await browse('?shops=faa0Ym'), [['Meierismør'], ['KIWI 2', 'REMA 1000 1']]);
  assert.deepEqual(await browse('?q=sm%C3%B8r&shops=257bxm,faa0Ym'), [['Smør'], ['KIWI 1', 'REMA 1000 0']]);
  assert.deepEqual(await browse('?q=*sm%C3%B8r&shops='), [['Meierismør', 'Smør'], ['KIWI 1', 'REMA 1000 1']]);
  assert.deepEqual(await browse('?shops=nope'), [['Egg', 'Meierismør', 'Smør'], ['KIWI 2', 'REMA 1000 1']]);
});

test('a write from another origin is refused, also when the Origin cannot be parsed', async () => {
  assert.equal((await send('POST', '/api/items', { name: 'x' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await send('PUT', '/api/settings', {}, { origin: 'null' })).status, 403);
});

test('an unreadable settings.json is kept aside at start, not overwritten', piOnly, () => {
  const dir = tmpDir();
  const broken = '{"trackedItems":[{"id":"1","na';
  fs.writeFileSync(path.join(dir, 'settings.json'), broken);
  const r = spawnSync(process.execPath, ['-e', "require('./server.js')"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const aside = fs.readdirSync(dir).find((f) => f.startsWith('settings.json.unreadable-'));
  assert.ok(aside, `files: ${fs.readdirSync(dir).join(', ')}`);
  assert.equal(fs.readFileSync(path.join(dir, aside), 'utf8'), broken);
  assert.match(r.stdout, /settings\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a location change during a fetch is fetched as soon as that fetch ends', piOnly, async (t) => {
  const fetched = [];
  t.mock.method(tjek, 'fetchDealerOffers', async (id, loc) => { await sleep(15); fetched.push(loc.name); return []; });
  t.mock.method(tjek, 'discoverDealers', async () => []);
  const place = (name, lat) => ({ location: { name, lat, lng: 10.75, radiusKm: 10 } });
  delete process.env.DISABLE_FETCH;  // the fetchers are stubbed above
  try {
    assert.equal((await send('PUT', '/api/settings', place('First', 59.9))).status, 200);
    await sleep(60);  // a few shops into the first fetch
    const shops = (await (await send('PUT', '/api/settings', place('Second', 60.4))).json()).settings.shops.length;
    for (let i = 0; i < 100 && fetched.filter((n) => n === 'Second').length < shops; i++) await sleep(20);
    assert.equal(fetched.filter((n) => n === 'Second').length, shops, 'every shop fetched for the new location, without waiting for the 15-minute tick');
    assert.equal(fetched.filter((n) => n === 'First').length, shops, 'the running fetch finished for the place it started with');
    for (let i = 0; i < 100 && (await state()).status.refreshing; i++) await sleep(20);
    assert.equal((await state()).status.refreshing, false);
  } finally {
    process.env.DISABLE_FETCH = '1';
  }
});
