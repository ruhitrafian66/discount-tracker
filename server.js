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
const OFFERS_TTL = 6 * 3600e3;
const KASSAL_TTL = 12 * 3600e3;

// ---- persistence ----------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
const file = (n) => path.join(DATA_DIR, n);

function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
async function save(name, data) {
  const tmp = file(name + '.tmp');
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file(name));
}

const DEFAULT_SETTINGS = {
  location: { name: 'Oslo', lat: 59.9139, lng: 10.7522, radiusKm: 10 },
  shops: tjek.GROCERY_DEALERS.map((d) => d.id),
  kassalKey: '',
  trackedItems: [],
};
const settings = { ...DEFAULT_SETTINGS, ...load('settings.json', {}) };
let offersCache = load('offers.json', { fetchedAt: 0, locKey: '', byDealer: {}, discovered: [], errors: [] });
const kassalCache = load('kassal.json', {});
const status = { refreshing: false, kassalRefreshing: false, kassalError: null };

const locKey = (l) => `${l.lat.toFixed(4)},${l.lng.toFixed(4)},${l.radiusKm}`;

// ---- refresh --------------------------------------------------------------

async function refreshOffers({ force = false } = {}) {
  if (status.refreshing) return;
  const lk = locKey(settings.location);
  const stale = Date.now() - offersCache.fetchedAt > OFFERS_TTL || offersCache.locKey !== lk;
  const missing = settings.shops.filter((id) => !offersCache.byDealer[id]);
  if (!force && !stale && !missing.length) return;

  status.refreshing = true;
  const toFetch = force || stale ? settings.shops : missing;
  const byDealer = force || stale ? {} : { ...offersCache.byDealer };
  const errors = [];
  try {
    for (const id of toFetch) {
      try {
        byDealer[id] = (await tjek.fetchDealerOffers(id, settings.location)).map(tjek.slim);
      } catch (e) {
        errors.push(`${dealerName(id)}: ${e.message}`);
        if (offersCache.byDealer[id] && offersCache.locKey === lk) byDealer[id] = offersCache.byDealer[id];
      }
    }
    let discovered = offersCache.discovered;
    if (force || stale || !discovered.length) {
      try { discovered = await tjek.discoverDealers(settings.location); } catch (e) { errors.push(`Shop discovery: ${e.message}`); }
    }
    offersCache = { fetchedAt: Date.now(), locKey: lk, byDealer, discovered, errors };
    await save('offers.json', offersCache);
    log(`offers refreshed: ${Object.values(byDealer).flat().length} offers from ${toFetch.length} shops${errors.length ? `, ${errors.length} errors` : ''}`);
  } finally {
    status.refreshing = false;
  }
}

async function refreshKassal({ force = false } = {}) {
  if (status.kassalRefreshing || !settings.kassalKey) return;
  status.kassalRefreshing = true;
  status.kassalError = null;
  try {
    const offers = weekOffers();
    for (const item of [...settings.trackedItems]) {
      const terms = engine.searchTerms(item, offers);
      const key = JSON.stringify(terms);
      const c = kassalCache[item.id];
      if (!force && c && c.termsKey === key && Date.now() - c.fetchedAt < KASSAL_TTL) continue;
      try {
        const products = await kassal.productsForTerms(settings.kassalKey, terms);
        kassalCache[item.id] = { fetchedAt: Date.now(), termsKey: key, products };
      } catch (e) {
        status.kassalError = e.status === 401 ? 'Kassalapp rejected the API key (401).' : e.message;
        if (e.status === 401) break;
      }
    }
    const ids = new Set(settings.trackedItems.map((i) => i.id));
    for (const id of Object.keys(kassalCache)) if (!ids.has(id)) delete kassalCache[id];
    await save('kassal.json', kassalCache);
  } finally {
    status.kassalRefreshing = false;
  }
}

// Kassalapp runs after offers: its search spellings are learned from the offers.
function refreshAll(opts) {
  refreshOffers(opts)
    .catch((e) => log('offers refresh failed:', e.message))
    .then(() => refreshKassal(opts))
    .catch((e) => log('kassal refresh failed:', e.message));
}

// ---- view model ---------------------------------------------------------

function allDealers() {
  const m = new Map(tjek.GROCERY_DEALERS.map((d) => [d.id, { ...d, grocery: true }]));
  for (const d of offersCache.discovered || []) if (!m.has(d.id)) m.set(d.id, { ...d, grocery: false });
  return [...m.values()];
}
function dealerName(id) { return (allDealers().find((d) => d.id === id) || { name: id }).name; }

function weekOffers() {
  const now = Date.now();
  return settings.shops.flatMap((id) => offersCache.byDealer[id] || []).filter((o) => engine.isThisWeek(o, now));
}

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
      offerCount: offers.length,
      weekEnds: engine.endOfWeek(Date.now()),
      errors: offersCache.errors,
      kassalItems: Object.keys(kassalCache).length,
    },
    result,
  };
}

// ---- validation ---------------------------------------------------------

const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((s) => str(s, 60)).filter(Boolean).slice(0, 20);

function cleanItem(body, id) {
  const name = str(body.name, 60);
  if (!name) throw httpError(400, 'Name is required');
  if (settings.trackedItems.some((i) => i.id !== id && engine.fold(i.name) === engine.fold(name))) {
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
  if (origin && new URL(origin).host !== req.headers.host) throw httpError(403, 'Cross-origin request refused');
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

  if (m === 'GET' && p === '/api/state') return send(res, 200, stateView());

  if (m === 'GET' && p === '/api/offers') {
    // Same word rules as tracked items, so a search here previews what a term would match.
    const q = engine.norm(url.searchParams.get('q')).slice(0, 100);
    const hits = weekOffers()
      .filter((o) => !q || engine.termMatches(q, o.heading, o.description))
      .sort((a, b) => a.heading.localeCompare(b.heading, 'nb'))
      .slice(0, 300)
      .map((o) => ({ id: o.id, heading: o.heading, description: o.description, price: o.pricing.price, prePrice: o.pricing.pre_price, shop: o.dealer.name, image: o.images.thumb, runTill: o.run_till }));
    return send(res, 200, { offers: hits });
  }

  if (m === 'POST' && p === '/api/refresh') {
    await readJson(req);
    refreshAll({ force: true });
    return send(res, 202, { ok: true });
  }

  if (m === 'PUT' && p === '/api/settings') {
    const b = await readJson(req);
    if (b.location) {
      const lat = Number(b.location.lat), lng = Number(b.location.lng), radiusKm = Number(b.location.radiusKm);
      if (!(lat >= 57 && lat <= 72 && lng >= 4 && lng <= 32)) throw httpError(400, 'Location must be in Norway');
      if (!(radiusKm >= 1 && radiusKm <= 100)) throw httpError(400, 'Radius must be 1–100 km');
      settings.location = { name: str(b.location.name, 60) || 'Custom', lat, lng, radiusKm };
    }
    if (Array.isArray(b.shops)) {
      const known = new Set(allDealers().map((d) => d.id));
      settings.shops = [...new Set(b.shops.filter((id) => known.has(id)))];
    }
    if (typeof b.kassalKey === 'string') {
      settings.kassalKey = str(b.kassalKey, 200);
      for (const k of Object.keys(kassalCache)) delete kassalCache[k];
    }
    await save('settings.json', settings);
    refreshAll();
    return send(res, 200, stateView());
  }

  if (m === 'POST' && p === '/api/items') {
    const item = cleanItem(await readJson(req), crypto.randomUUID());
    if (settings.trackedItems.length >= 200) throw httpError(400, 'Too many tracked items');
    settings.trackedItems.push(item);
    await save('settings.json', settings);
    refreshKassal().catch((e) => log(e.message));
    return send(res, 201, stateView());
  }

  const im = p.match(/^\/api\/items\/([\w-]+)$/);
  if (im && (m === 'PUT' || m === 'DELETE')) {
    const idx = settings.trackedItems.findIndex((i) => i.id === im[1]);
    if (idx < 0) throw httpError(404, 'No such item');
    if (m === 'PUT') settings.trackedItems[idx] = cleanItem(await readJson(req), im[1]);
    else { await readJson(req); settings.trackedItems.splice(idx, 1); }
    await save('settings.json', settings);
    refreshKassal().catch((e) => log(e.message));
    return send(res, 200, stateView());
  }

  throw httpError(404, 'Not found');
}

async function staticFile(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  try {
    const body = await fsp.readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET') await staticFile(res, url.pathname);
    else send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') log('error:', e.stack || e.message);
    if (!res.headersSent) send(res, typeof e.code === 'number' ? e.code : 500, { error: typeof e.code === 'number' ? e.message : 'Internal error' });
  }
});

function log(...a) { console.log(new Date().toISOString(), ...a); }

if (require.main === module) {
  server.listen(PORT, HOST, () => log(`discount-tracker listening on http://${HOST}:${PORT}`));
  if (!process.env.DISABLE_FETCH) {  // set in CI to avoid calling external APIs
    refreshAll();
    setInterval(() => refreshAll(), 30 * 60e3).unref();
  }
}

module.exports = { server };
