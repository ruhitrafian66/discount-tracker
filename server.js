'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const engine = require('./lib/engine');
const tjek = require('./lib/tjek');
const kassal = require('./lib/kassal');

const PORT = Number(process.env.PORT || 3003);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
// Weekly fetch slot: FETCH_WEEKDAY (0=Sun, 1=Mon) at FETCH_HOUR:00 Oslo time. Default Monday 01:00.
const FETCH_WEEKDAY = Number(process.env.FETCH_WEEKDAY || 1);
const FETCH_HOUR = Number(process.env.FETCH_HOUR || 1);
const slots = () => engine.fetchSlots(Date.now(), FETCH_WEEKDAY, FETCH_HOUR);

// ---- persistence ----------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
const file = (n) => path.join(DATA_DIR, n);

// A missing file is a first run. One that cannot be parsed falls back too; with `keep`
// it is first moved aside, so the next save does not overwrite what might be recovered.
function load(name, fallback, { keep = false } = {}) {
  let text;
  try { text = fs.readFileSync(file(name), 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') log(`cannot read ${name}: ${e.message}`);
    return fallback;
  }
  try { return JSON.parse(text); } catch (e) {
    let kept = '';
    if (keep) {
      const aside = `${name}.unreadable-${Date.now()}`;
      try { fs.renameSync(file(name), file(aside)); kept = `; kept as ${aside}`; } catch { /* stays where it is */ }
    }
    log(`${name} is not valid JSON (${e.message})${kept}; starting without it`);
    return fallback;
  }
}

// Each write goes through its own temp file, and writes to one file run one after the
// other, so saves arriving together cannot collide. Callers change memory themselves
// (and call touch()): caches before the write, settings only after it succeeded.
const writes = new Map();  // file name -> its latest write
let tmpSeq = 0;
function save(name, data) {
  const json = JSON.stringify(data);  // the data as of now, even if the write has to wait
  const write = async () => {
    const tmp = file(`${name}.${process.pid}.${++tmpSeq}.tmp`);
    try {
      await fsp.writeFile(tmp, json);
      await fsp.rename(tmp, file(name));
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  };
  const p = (writes.get(name) || Promise.resolve()).then(write, write);
  writes.set(name, p);
  return p;
}

// ---- view cache -------------------------------------------------------------
// Computing the deals view costs real CPU on a small board, and its inputs only
// change when settings, offers or Kassalapp data change. `rev` counts those
// changes (touch() bumps it); cached values are reused while it stands still.
// They also expire by time, because "this week" and the next fetch move with the clock.
let rev = 0;
function touch() { rev++; }
const VIEW_TTL = 5 * 60e3;
function cached(fn) {
  let key = null, at = 0, value;
  return () => {
    const k = `${rev}|${status.refreshing}|${status.kassalRefreshing}|${status.kassalError}`;
    if (k !== key || Date.now() - at > VIEW_TTL) { value = fn(); key = k; at = Date.now(); }
    return value;
  };
}

const DEFAULT_SETTINGS = {
  location: { name: 'Oslo', lat: 59.9139, lng: 10.7522, radiusKm: 10 },
  shops: tjek.GROCERY_DEALERS.map((d) => d.id),
  kassalKey: '',
  trackedItems: [],
};
// Replaced, never edited in place: see updateSettings().
let settings = { ...DEFAULT_SETTINGS, ...load('settings.json', {}, { keep: true }) };
// Settings change one at a time: build the new object from the current one, write it,
// then swap it in. A failed write leaves memory as it was, and two requests arriving
// together cannot overwrite each other. `change` may throw an httpError.
let settingsQueue = Promise.resolve();
function updateSettings(change) {
  const p = settingsQueue.then(async () => {
    const next = change(settings);
    await save('settings.json', next);
    settings = next;
    touch();
  });
  settingsQueue = p.catch(() => {});
  return p;
}
// Bump when the stored offer shape changes (tjek.slim): the cache is then rebuilt
// once, off-schedule. v2 added `url`.
const OFFERS_CACHE_V = 2;
let offersCache = load('offers.json', { fetchedAt: 0, locKey: '', byDealer: {}, discovered: [], errors: [] });
const kassalCache = load('kassal.json', {});
const status = { refreshing: false, kassalRefreshing: false, kassalError: null };
const failedAt = new Map();  // dealerId -> time of last failed fetch

const locKey = (l) => `${l.lat.toFixed(4)},${l.lng.toFixed(4)},${l.radiusKm}`;

// ---- refresh --------------------------------------------------------------

// Offers are fetched once per weekly slot (see engine.fetchSlots) and kept all week.
// Outside the slot, the API is only called for data the cache cannot have:
// a changed location, a newly selected shop, or a shop whose fetch failed (retried).
async function refreshOffers() {
  const { location, shops } = settings;  // as they are now: a change during the fetch gets its own pass
  const lk = locKey(location);
  const stale = offersCache.fetchedAt < slots().last || offersCache.locKey !== lk || offersCache.v !== OFFERS_CACHE_V;
  // Failed shops are retried at most hourly.
  const missing = shops.filter((id) => !offersCache.byDealer[id] && !(Date.now() - (failedAt.get(id) || 0) < 3600e3));
  if (!stale && !missing.length) return;

  status.refreshing = true;
  const toFetch = stale ? shops : missing;
  const byDealer = stale ? {} : { ...offersCache.byDealer };
  const errors = [];
  try {
    for (const id of toFetch) {
      try {
        byDealer[id] = (await tjek.fetchDealerOffers(id, location)).map(tjek.slim);
        failedAt.delete(id);
      } catch (e) {
        errors.push(`${dealerName(id)}: ${e.message}`);  // left missing -> retried later
        failedAt.set(id, Date.now());
      }
    }
    let discovered = offersCache.discovered;
    if (stale || !discovered.length) {
      try { discovered = await tjek.discoverDealers(location); } catch (e) { errors.push(`Shop discovery: ${e.message}`); }
    }
    offersCache = { v: OFFERS_CACHE_V, fetchedAt: stale ? Date.now() : offersCache.fetchedAt, locKey: lk, byDealer, discovered, errors };
    touch();
    await save('offers.json', offersCache);
    log(`offers refreshed: ${Object.values(byDealer).flat().length} offers from ${toFetch.length} shops${errors.length ? `, ${errors.length} errors` : ''}`);
  } finally {
    status.refreshing = false;
  }
}

async function refreshKassal() {
  const { kassalKey, trackedItems } = settings;
  if (!kassalKey) return;
  status.kassalRefreshing = true;
  status.kassalError = null;
  let changed = false;  // the file is only rewritten when a lookup ran or an entry went
  try {
    const offers = weekOffers();
    for (const item of trackedItems) {
      const terms = engine.searchTerms(item, offers);
      const key = JSON.stringify(['v2', terms]);  // bump when the cached product shape changes
      const c = kassalCache[item.id];
      if (c && c.termsKey === key && c.fetchedAt >= slots().last) continue;
      try {
        const products = await kassal.productsForTerms(kassalKey, terms);
        kassalCache[item.id] = { fetchedAt: Date.now(), termsKey: key, products };
        touch();
        changed = true;
      } catch (e) {
        status.kassalError = e.status === 401 ? 'Kassalapp rejected the API key (401).' : e.message;
        if (e.status === 401) break;
      }
    }
    const ids = new Set(settings.trackedItems.map((i) => i.id));
    for (const id of Object.keys(kassalCache)) if (!ids.has(id)) { delete kassalCache[id]; changed = true; }
    if (changed) {
      touch();
      await save('kassal.json', kassalCache);
    }
  } finally {
    status.kassalRefreshing = false;
  }
}

// One refresh at a time. A request that arrives while one runs (a new item, a changed
// location) starts another pass as soon as it ends, instead of waiting for the next tick.
// Kassalapp runs after offers: its search spellings are learned from the offers.
let refreshing = null, refreshAgain = false;
function refreshAll() {
  if (process.env.DISABLE_FETCH) return Promise.resolve();  // set in CI and tests: no external API calls
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await refreshOffers().catch((e) => log('offers refresh failed:', e.message));
      await refreshKassal().catch((e) => log('kassal refresh failed:', e.message));
    } while (refreshAgain);
    stateBody();  // warm the view cache so the next page load is instant
  })().catch((e) => log('refresh failed:', e.message)).finally(() => { refreshing = null; });
  return refreshing;
}

// ---- view model ---------------------------------------------------------

function allDealers() {
  const m = new Map(tjek.GROCERY_DEALERS.map((d) => [d.id, { ...d, grocery: true }]));
  for (const d of offersCache.discovered || []) if (!m.has(d.id)) m.set(d.id, { ...d, grocery: false });
  return [...m.values()];
}
function dealerName(id) { return (allDealers().find((d) => d.id === id) || { name: id }).name; }

const weekOffers = cached(() => {
  const now = Date.now(), end = engine.endOfWeek(now);
  return settings.shops.flatMap((id) => offersCache.byDealer[id] || []).filter((o) => engine.isThisWeek(o, now, end));
});

function stateView() {
  const offers = weekOffers();
  const shopKeys = settings.shops.map((id) => engine.shopKey(dealerName(id)));
  const kassalData = settings.kassalKey ? Object.fromEntries(Object.entries(kassalCache).map(([k, v]) => [k, v.products])) : {};
  const result = engine.compute({ offers, trackedItems: settings.trackedItems, shopKeys, kassal: kassalData, kassalEnabled: Boolean(settings.kassalKey) });
  return {
    settings: {
      location: settings.location,
      shops: settings.shops,
      trackedItems: settings.trackedItems,
      kassalKeySet: Boolean(settings.kassalKey),
    },
    dealers: allDealers(),
    status: {
      ...status,
      fetchedAt: offersCache.fetchedAt,
      nextFetch: slots().next,
      offerCount: offers.length,
      weekEnds: engine.endOfWeek(Date.now()),
      errors: offersCache.errors,
      kassalItems: Object.keys(kassalCache).length,
    },
    result,
  };
}

// The state as served: serialised once per change, with an ETag so a reload of
// an unchanged page gets an empty 304.
const stateBody = cached(() => {
  const body = JSON.stringify(stateView());
  return { body, etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"` };
});

// nginx turns our ETag into a weak one (W/"...") when it gzips the response.
function etagMatches(req, etag) {
  const inm = req.headers['if-none-match'];
  return Boolean(inm) && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

function sendState(req, res, code = 200) {
  const { body, etag } = stateBody();
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
  if (code === 200 && etagMatches(req, etag)) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(code, headers);
  res.end(body);
}

// ---- validation ---------------------------------------------------------

const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((s) => str(s, 60)).filter(Boolean).slice(0, 20);

function cleanItem(body, id, items) {
  const name = str(body.name, 60);
  if (!name) throw httpError(400, 'Name is required');
  if (items.some((i) => i.id !== id && engine.fold(i.name) === engine.fold(name))) {
    throw httpError(409, `Already tracking "${name}"`);
  }
  const terms = list(body.terms);
  return { id, name, terms: terms.length ? terms : [name], exclude: list(body.exclude) };
}

function httpError(code, message) { return Object.assign(new Error(message), { code }); }

// ---- http ---------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readJson(req) {
  // Requiring a JSON content type and same-origin blocks cross-site form posts from other pages.
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, 'JSON required');
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* "null" and the like: refused below */ }
    if (host !== req.headers.host) throw httpError(403, 'Cross-origin request refused');
  }
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64e3) throw httpError(413, 'Body too large');
  }
  try { return data ? JSON.parse(data) : {}; } catch { throw httpError(400, 'Invalid JSON'); }
}

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;

  if (m === 'GET' && p === '/api/state') return sendState(req, res);

  if (m === 'GET' && p === '/api/offers') {
    // Same word rules as tracked items, so a search here previews what a term would match.
    const q = engine.norm(url.searchParams.get('q')).slice(0, 100);
    // ?shops=id,id narrows the offers to those shops; `shops` in the answer lists every
    // shop with offers and its number of matches, for the filter on the Browse page.
    const only = (url.searchParams.get('shops') || '').split(',');
    return send(res, 200, engine.browse(weekOffers(), q, only));
  }

  if (m === 'PUT' && p === '/api/settings') {
    const b = await readJson(req);
    await updateSettings((s) => {
      const next = { ...s };
      if (b.location) {
        const lat = Number(b.location.lat), lng = Number(b.location.lng), radiusKm = Number(b.location.radiusKm);
        if (!(lat >= 57 && lat <= 72 && lng >= 4 && lng <= 32)) throw httpError(400, 'Location must be in Norway');
        if (!(radiusKm >= 1 && radiusKm <= 100)) throw httpError(400, 'Radius must be 1–100 km');
        next.location = { name: str(b.location.name, 60) || 'Custom', lat, lng, radiusKm };
      }
      if (Array.isArray(b.shops)) {
        const known = new Set(allDealers().map((d) => d.id));
        next.shops = [...new Set(b.shops.filter((id) => known.has(id)))];
      }
      if (typeof b.kassalKey === 'string') next.kassalKey = str(b.kassalKey, 200);
      return next;
    });
    if (typeof b.kassalKey === 'string') {
      for (const k of Object.keys(kassalCache)) delete kassalCache[k];
      touch();
    }
    refreshAll();
    return sendState(req, res);
  }

  if (m === 'POST' && p === '/api/items') {
    const b = await readJson(req);
    await updateSettings((s) => {
      const item = cleanItem(b, crypto.randomUUID(), s.trackedItems);
      if (s.trackedItems.length >= 200) throw httpError(400, 'Too many tracked items');
      return { ...s, trackedItems: [...s.trackedItems, item] };
    });
    refreshAll();
    return sendState(req, res, 201);
  }

  // Bulk delete: { ids: [...] }
  if (m === 'POST' && p === '/api/items/delete') {
    const b = await readJson(req);
    const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : []);
    if (!ids.size) throw httpError(400, 'No items selected');
    await updateSettings((s) => ({ ...s, trackedItems: s.trackedItems.filter((i) => !ids.has(i.id)) }));
    return sendState(req, res);
  }

  const im = p.match(/^\/api\/items\/([\w-]+)$/);
  if (im && (m === 'PUT' || m === 'DELETE')) {
    if (!settings.trackedItems.some((i) => i.id === im[1])) throw httpError(404, 'No such item');
    const b = await readJson(req);
    await updateSettings((s) => {
      const idx = s.trackedItems.findIndex((i) => i.id === im[1]);
      if (idx < 0) throw httpError(404, 'No such item');
      const items = [...s.trackedItems];
      if (m === 'PUT') items[idx] = cleanItem(b, im[1], items);
      else items.splice(idx, 1);
      return { ...s, trackedItems: items };
    });
    refreshAll();
    return sendState(req, res);
  }

  throw httpError(404, 'Not found');
}

async function staticFile(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  try {
    const st = await fsp.stat(full);
    if (!st.isFile()) throw new Error('not a file');
    // Files only change on deploy; the browser revalidates and usually gets a 304.
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const headers = { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
    if (etagMatches(req, etag)) { res.writeHead(304, headers); return res.end(); }
    const body = await fsp.readFile(full);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET') await staticFile(req, res, url.pathname);
    else send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') log('error:', e.stack || e.message);
    if (!res.headersSent) send(res, typeof e.code === 'number' ? e.code : 500, { error: typeof e.code === 'number' ? e.message : 'Internal error' });
  }
});

function log(...a) { console.log(new Date().toISOString(), ...a); }

if (require.main === module) {
  server.listen(PORT, HOST, () => log(`discount-tracker listening on http://${HOST}:${PORT}`));
  setImmediate(() => { const t = Date.now(); stateBody(); log(`view cache warmed in ${Date.now() - t} ms`); });
  if (!process.env.DISABLE_FETCH) {  // set in CI to avoid calling external APIs
    // Cheap local check; it only calls the APIs when the weekly slot has passed
    // (or after downtime over the slot, or for a failed shop).
    refreshAll();
    setInterval(() => refreshAll(), 15 * 60e3).unref();
  }
}

module.exports = { server };
