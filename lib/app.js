'use strict';
// The app core: API routes, per-browser tracked items, and the offer/Kassalapp refresh.
// Host-neutral: it takes a web-standard Request and returns a Response, and stores
// everything through lib/store.js. server.js runs it on the Pi (JSON files);
// netlify/functions/*.mjs run it on Netlify (Blobs).
//
// Data model:
//   settings          shared: location (changing it needs ADMIN_CODE), default shops for
//                     new visitors. The Kassalapp key comes from KASSAL_KEY only; no route
//                     changes it.
//   offers            shared: this week's offers per shop (OFFERS_CACHE_V)
//   kassal            shared: Kassalapp products per search-term set, so users who
//                     track the same thing share one lookup
//   flags             small markers: kassalDirtyAt, visitorsCleanedAt, wantedShops (shops
//                     some visitor picked beyond the grocery chains, so they get fetched)
//   visitors/<sha256> one browser's tracked items and shops, keyed by a hash of the random
//                     ID in its cookie (no accounts; the ID itself is only in the cookie)

const crypto = require('node:crypto');
const engine = require('./engine');
const tjek = require('./tjek');
const kassal = require('./kassal');

// Bump when the stored offer shape changes (tjek.slim). v2 added `url`; v3 stores the
// fetch time per shop, so a weekly fetch can be split over several short runs (Netlify).
const OFFERS_CACHE_V = 3;
const DEFAULT_SETTINGS = {
  location: { name: 'Oslo', lat: 59.9139, lng: 10.7522, radiusKm: 10 },
  shops: tjek.GROCERY_DEALERS.map((d) => d.id),
  kassalKey: '',
};
const COOKIE = 'tt_visitor';
const COOKIE_DAYS = 400;     // the longest browsers allow; renewed on every save
const VIEW_TTL = 5 * 60e3;   // "this week" and the next fetch move with the clock
const MAX_ITEMS = 200;
const TOKEN_RE = /^[\w-]{43}$/;  // 32 random bytes, base64url

const locKey = (l) => `${l.lat.toFixed(4)},${l.lng.toFixed(4)},${l.radiusKm}`;
const emptyOffers = (lk = '') => ({ v: OFFERS_CACHE_V, locKey: lk, byDealer: {}, discovered: [], discoveredAt: 0, errors: {}, failedAt: {} });
const emptyKassal = () => ({ entries: {}, error: null, doneAt: 0 });

// Older caches (Pi data dirs) are converted rather than refetched.
function migrateOffers(o) {
  if (!o) return emptyOffers();
  if (o.v === OFFERS_CACHE_V) return o;
  if (o.v === 2) {
    const byDealer = Object.fromEntries(Object.entries(o.byDealer || {}).map(([id, list]) => [id, { at: o.fetchedAt, offers: list }]));
    return { ...emptyOffers(o.locKey), byDealer, discovered: o.discovered || [], discoveredAt: o.fetchedAt };
  }
  return emptyOffers();
}
function migrateKassal(k) {
  if (!k) return emptyKassal();
  if (k.entries) return k;
  // v1: { [itemId]: { fetchedAt, termsKey, products } }
  const entries = {};
  for (const v of Object.values(k)) if (v && v.termsKey) entries[v.termsKey] = { fetchedAt: v.fetchedAt, products: v.products };
  return { ...emptyKassal(), entries };
}

function httpError(code, message) { return Object.assign(new Error(message), { code }); }
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((s) => str(s, 60)).filter(Boolean).slice(0, 20);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff' };
function json(code, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });
}

async function readJson(req) {
  // Requiring a JSON content type and same-origin blocks cross-site form posts from other pages.
  if (!String(req.headers.get('content-type') || '').startsWith('application/json')) throw httpError(415, 'JSON required');
  const origin = req.headers.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { throw httpError(403, 'Cross-origin request refused'); }
    if (host !== new URL(req.url).host) throw httpError(403, 'Cross-origin request refused');
  }
  const text = await req.text();
  if (text.length > 64e3) throw httpError(413, 'Body too large');
  try { return text ? JSON.parse(text) : {}; } catch { throw httpError(400, 'Invalid JSON'); }
}

function readCookie(req, name) {
  for (const part of String(req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function createApp({ store, env = process.env, globalTtlMs = Infinity, log = (...a) => console.log(new Date().toISOString(), ...a) }) {
  const FETCH_WEEKDAY = Number(env.FETCH_WEEKDAY || 1);
  const FETCH_HOUR = Number(env.FETCH_HOUR || 1);
  const slots = () => engine.fetchSlots(Date.now(), FETCH_WEEKDAY, FETCH_HOUR);
  const fetchDisabled = Boolean(env.DISABLE_FETCH);  // set in CI and tests to avoid calling external APIs
  const adminCode = String(env.ADMIN_CODE || '');  // unset: shared settings are locked
  const envKassalKey = String(env.KASSAL_KEY || '');

  // ---- shared data ----------------------------------------------------------
  // Loaded once and kept in memory. On Netlify other instances (the scheduled
  // refresh) can change it, so it is reloaded after globalTtlMs.
  // `rev` counts changes; cached views are reused while it stands still.
  let G = null, loadedAt = 0, loading = null, rev = 0;
  function global(force = false) {
    if (G && !force && Date.now() - loadedAt < globalTtlMs) return Promise.resolve(G);
    if (!loading) {
      loading = Promise.all(['settings', 'offers', 'kassal', 'flags'].map((k) => store.get(k)))
        .then(([settings, offers, kas, flags]) => {
          G = { settings: { ...DEFAULT_SETTINGS, ...(settings || {}) }, offers: migrateOffers(offers), kassal: migrateKassal(kas), flags: flags || {} };
          loadedAt = Date.now(); rev++;
          return G;
        })
        .finally(() => { loading = null; });
    }
    return loading;
  }
  async function saveGlobal(name, value) {
    await global();
    G = { ...G, [name]: value };
    rev++;
    await store.set(name, value);
  }

  const kassalKeyOf = (s) => s.kassalKey || envKassalKey;

  function allDealers(g) {
    const m = new Map(tjek.GROCERY_DEALERS.map((d) => [d.id, { ...d, grocery: true }]));
    for (const d of g.offers.discovered || []) if (!m.has(d.id)) m.set(d.id, { ...d, grocery: false });
    return [...m.values()];
  }
  const dealerName = (g, id) => (allDealers(g).find((d) => d.id === id) || { name: id }).name;

  // Shops whose offers are fetched: every grocery chain, the default selection, and any
  // other chain a visitor picked. Each visitor then compares only their own shops.
  // The grocery chains are the default selection anyway, so this adds no API calls
  // unless someone picks an extra chain.
  function fetchShops(g) {
    return [...new Set([...tjek.GROCERY_DEALERS.map((d) => d.id), ...g.settings.shops, ...(g.flags.wantedShops || [])])];
  }

  // All fetched offers this week; each view narrows them to the visitor's shops.
  let weekCache = { key: null };
  function weekOffers(g) {
    if (weekCache.key !== rev || Date.now() - weekCache.at > VIEW_TTL) {
      const now = Date.now(), end = engine.endOfWeek(now);
      const value = fetchShops(g).flatMap((id) => (g.offers.byDealer[id] || {}).offers || []).filter((o) => engine.isThisWeek(o, now, end));
      weekCache = { key: rev, at: now, value };
    }
    return weekCache.value;
  }

  // The Kassalapp cache is keyed by an item's search spellings, which are learned
  // from this week's offers. Items are replaced, never edited, so a WeakMap is safe.
  const termsMemo = new WeakMap();
  function termsKeyFor(item, offers) {
    const m = termsMemo.get(item);
    if (m && m.offers === offers) return m.key;
    const terms = engine.searchTerms(item, offers);
    const key = JSON.stringify(['v2', terms]);
    termsMemo.set(item, { offers, key, terms });
    return key;
  }

  // ---- refresh ----------------------------------------------------------------
  // Offers are fetched once per weekly slot (engine.fetchSlots) and kept all week.
  // Outside the slot, the API is only called for data the cache cannot have: a changed
  // location, a newly selected shop, a shop whose fetch failed (retried at most hourly),
  // and Kassalapp lookups for new or edited items.
  const working = { offers: false, kassal: false };

  function dealersToFetch(g) {
    const s = g.settings, o = g.offers, last = slots().last;
    const sameLoc = o.locKey === locKey(s.location);
    return fetchShops(g).filter((id) => {
      const e = sameLoc && o.byDealer[id];
      if (e && e.at >= last) return false;
      return !(Date.now() - (o.failedAt[id] || 0) < 3600e3);
    });
  }
  function kassalPending(g) {
    if (!kassalKeyOf(g.settings)) return false;
    return g.kassal.doneAt < slots().last || (g.flags.kassalDirtyAt || 0) > g.kassal.doneAt;
  }

  async function refreshOffers(deadline) {
    const g = await global();
    const s = g.settings, lk = locKey(s.location);
    const o = g.offers.locKey === lk ? g.offers : emptyOffers(lk);
    const todo = dealersToFetch({ ...g, offers: o });
    const needDiscover = !o.discovered.length || o.discoveredAt < slots().last;
    if (!todo.length && !needDiscover) return;

    working.offers = true;
    const byDealer = { ...o.byDealer }, errors = { ...o.errors }, failedAt = { ...o.failedAt };
    let { discovered, discoveredAt } = o, fetched = 0;
    try {
      for (const id of todo) {
        if (Date.now() > deadline) break;  // the next run continues
        try {
          byDealer[id] = { at: Date.now(), offers: (await tjek.fetchDealerOffers(id, s.location)).map(tjek.slim) };
          delete errors[id]; delete failedAt[id];
          fetched++;
        } catch (e) {
          errors[id] = `${dealerName(g, id)}: ${e.message}`;
          failedAt[id] = Date.now();
        }
      }
      if (needDiscover && Date.now() < deadline) {
        try { discovered = await tjek.discoverDealers(s.location); discoveredAt = Date.now(); delete errors._discovery; } catch (e) { errors._discovery = `Shop discovery: ${e.message}`; }
      }
      await saveGlobal('offers', { v: OFFERS_CACHE_V, locKey: lk, byDealer, discovered, discoveredAt, errors, failedAt });
      log(`offers refreshed: ${fetched} of ${todo.length} shops${Object.keys(errors).length ? `, ${Object.keys(errors).length} errors` : ''}`);
    } finally {
      working.offers = false;
    }
  }

  async function allItems() {
    const docs = await Promise.all((await store.list('visitors/')).map((k) => store.get(k)));
    return docs.filter(Boolean).flatMap((v) => v.items || []);
  }

  // Kassalapp runs after offers: its search spellings are learned from the offers.
  async function refreshKassal(deadline) {
    const g = await global();
    const key = kassalKeyOf(g.settings);
    if (!key || !kassalPending(g)) return;
    working.kassal = true;
    const startedAt = Date.now(), last = slots().last;
    try {
      const offers = weekOffers(g);
      const want = new Map();
      for (const item of await allItems()) {
        const k = termsKeyFor(item, offers);
        want.set(k, termsMemo.get(item).terms);
      }
      const entries = {};
      for (const k of want.keys()) if (g.kassal.entries[k]) entries[k] = g.kassal.entries[k];
      let error = null, complete = true, authFailed = false;
      for (const [k, terms] of want) {
        const e = entries[k];
        if (e && e.fetchedAt >= last) continue;
        if (Date.now() > deadline) { complete = false; break; }
        try {
          entries[k] = { fetchedAt: Date.now(), products: await kassal.productsForTerms(key, terms) };
        } catch (err) {
          error = err.status === 401 ? 'Kassalapp rejected the API key (401).' : err.message;
          if (err.status === 401) { authFailed = true; break; }
          complete = false;
        }
      }
      // A rejected key stops lookups until the key changes (that resets doneAt).
      // Items added during this pass have kassalDirtyAt > startedAt and trigger another.
      await saveGlobal('kassal', { entries, error, doneAt: complete || authFailed ? startedAt : g.kassal.doneAt });
    } finally {
      working.kassal = false;
    }
  }

  // A visitor not seen for longer than the cookie lives can never come back.
  async function cleanVisitors() {
    const g = await global();
    if ((g.flags.visitorsCleanedAt || 0) >= slots().last) return;
    // Also rebuild wantedShops, so a chain nobody picks any more stops being fetched.
    const base = new Set([...tjek.GROCERY_DEALERS.map((d) => d.id), ...g.settings.shops]);
    const wanted = new Set();
    for (const k of await store.list('visitors/')) {
      const v = await store.get(k);
      if (!v || v.seenAt < Date.now() - COOKIE_DAYS * 864e5) { await store.del(k); continue; }
      for (const id of v.shops || []) if (!base.has(id)) wanted.add(id);
    }
    await saveGlobal('flags', { ...G.flags, wantedShops: [...wanted], visitorsCleanedAt: Date.now() });
  }

  // One refresh at a time per process. budgetMs bounds how long it keeps starting
  // new API calls (Netlify functions are time-limited); unfinished work resumes on the next run.
  let workP = null;
  function work({ budgetMs = Infinity } = {}) {
    if (fetchDisabled) return Promise.resolve();
    if (!workP) {
      const deadline = Date.now() + budgetMs;
      workP = global(true)
        .then(() => refreshOffers(deadline).catch((e) => log('offers refresh failed:', e.message)))
        .then(() => refreshKassal(deadline).catch((e) => log('kassal refresh failed:', e.message)))
        .then(() => cleanVisitors().catch((e) => log('visitor cleanup failed:', e.message)))
        .finally(() => { workP = null; });
    }
    return workP;
  }

  async function markKassalDirty() {
    const g = await global();
    if (kassalKeyOf(g.settings)) await saveGlobal('flags', { ...g.flags, kassalDirtyAt: Date.now() });
  }

  // ---- visitors -------------------------------------------------------------------
  // No accounts: each browser gets a random ID in an HttpOnly cookie, and its tracked
  // items are stored under a hash of that ID. Nothing is stored (and no cookie set)
  // until the first save, so page views and crawlers create nothing.

  async function visitor(req) {
    const token = readCookie(req, COOKIE);
    if (!token || !TOKEN_RE.test(token)) return { id: null, token: null, items: [], shops: null, rev: 0 };
    const id = `visitors/${sha256(token).toString('hex')}`;
    const doc = await store.get(id);
    // shops: null until the visitor picks their own; then the default applies.
    return { id, token, items: (doc && doc.items) || [], shops: (doc && doc.shops) || null, rev: (doc && doc.rev) || 0 };
  }

  function cookieHeader(req, token) {
    const https = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}${https ? '; Secure' : ''}`;
  }

  // Saves the visitor's items and/or shops, creating its ID on the first save. Returns
  // the updated visitor and the cookie to send (sent on every save, renewing its lifetime).
  async function saveVisitor(req, v, { items = v.items, shops = v.shops } = {}) {
    const token = v.token || crypto.randomBytes(32).toString('base64url');
    const id = `visitors/${sha256(token).toString('hex')}`;
    const rev = v.rev + 1;
    await store.set(id, { items, shops, rev, seenAt: Date.now() });
    return { v: { id, token, items, shops, rev }, headers: { 'Set-Cookie': cookieHeader(req, token) } };
  }
  const shopsOf = (g, v) => v.shops || g.settings.shops;

  // Shared settings change for everyone, so they need ADMIN_CODE. Wrong codes are
  // throttled per process (on Netlify per function instance).
  let wrongCodes = { n: 0, at: 0 };
  function checkAdmin(code) {
    if (!adminCode) throw httpError(403, 'Shared settings are locked. Set ADMIN_CODE on the server to change them.');
    if (wrongCodes.n >= 10 && Date.now() - wrongCodes.at < 15 * 60e3) throw httpError(429, 'Too many wrong codes. Try again in 15 minutes.');
    if (!safeEqual(str(code, 200), adminCode)) {
      wrongCodes = { n: Date.now() - wrongCodes.at < 15 * 60e3 ? wrongCodes.n + 1 : 1, at: Date.now() };
      throw httpError(403, 'Wrong admin code');
    }
    wrongCodes = { n: 0, at: 0 };
  }

  // ---- view -----------------------------------------------------------------

  function stateView(g, v) {
    const s = g.settings;
    const offers = weekOffers(g);
    const key = kassalKeyOf(s);
    const shops = shopsOf(g, v);
    const shopKeys = shops.map((id) => engine.shopKey(dealerName(g, id)));
    const kassalData = {};
    if (key) {
      for (const item of v.items) {
        const e = g.kassal.entries[termsKeyFor(item, offers)];
        if (e) kassalData[item.id] = e.products;
      }
    }
    const result = engine.compute({ offers, trackedItems: v.items, shopKeys, kassal: kassalData, kassalEnabled: Boolean(key) });
    const fetchedAt = Math.max(0, ...shops.map((id) => (g.offers.byDealer[id] || {}).at || 0));
    return {
      settings: {
        location: s.location,
        shops,
        trackedItems: v.items,
        adminCodeSet: Boolean(adminCode),
        kassalKeySet: Boolean(key),
      },
      dealers: allDealers(g),
      status: {
        refreshing: working.offers || (!fetchDisabled && dealersToFetch(g).some((id) => shops.includes(id))),
        kassalRefreshing: working.kassal || (!fetchDisabled && kassalPending(g)),
        kassalError: g.kassal.error,
        fetchedAt,
        nextFetch: slots().next,
        offerCount: offers.length,
        weekEnds: engine.endOfWeek(Date.now()),
        errors: Object.entries(g.offers.errors).filter(([id]) => id === '_discovery' || shops.includes(id)).map(([, m]) => m),
      },
      result,
    };
  }

  // Serialised once per change per visitor, with an ETag so an unchanged reload gets a 304.
  const views = new Map();  // visitor id ('' for a browser with nothing saved) -> { key, at, body, etag }
  async function stateBody(vis) {
    const g = await global();
    const id = vis.id || '';
    const k = `${rev}|${vis.rev}|${working.offers}|${working.kassal}`;
    let c = views.get(id);
    if (!c || c.key !== k || Date.now() - c.at > VIEW_TTL) {
      const body = JSON.stringify(stateView(g, vis));
      c = { key: k, at: Date.now(), body, etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"` };
      views.delete(id);
      views.set(id, c);
      if (views.size > 200) views.delete(views.keys().next().value);
    }
    return c;
  }

  // nginx turns our ETag into a weak one (W/"...") when it gzips the response.
  function etagMatches(req, etag) {
    const inm = req.headers.get('if-none-match');
    return Boolean(inm) && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
  }

  async function state(req, vis, code = 200, extra = {}) {
    const { body, etag } = await stateBody(vis);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', Vary: 'Cookie', ETag: etag, ...SECURITY_HEADERS, ...extra };
    if (code === 200 && !extra['Set-Cookie'] && etagMatches(req, etag)) return new Response(null, { status: 304, headers });
    return new Response(body, { status: code, headers });
  }

  // ---- validation -------------------------------------------------------------

  function cleanItem(body, id, items) {
    const name = str(body.name, 60);
    if (!name) throw httpError(400, 'Name is required');
    if (items.some((i) => i.id !== id && engine.fold(i.name) === engine.fold(name))) {
      throw httpError(409, `Already tracking "${name}"`);
    }
    const terms = list(body.terms);
    return { id, name, terms: terms.length ? terms : [name], exclude: list(body.exclude) };
  }

  // ---- routes -------------------------------------------------------------------

  // `background(promise)` keeps work running after the response (Pi: just runs;
  // Netlify: context.waitUntil, bounded by the function's time limit).
  async function api(req, background) {
    const url = new URL(req.url);
    const m = req.method, p = url.pathname;

    const vis = await visitor(req);
    if (m === 'GET' && p === '/api/state') return state(req, vis);

    if (m === 'GET' && p === '/api/offers') {
      // Same word rules as tracked items, so a search here previews what a term would match.
      const q = engine.norm(url.searchParams.get('q')).slice(0, 100);
      const g = await global();
      const mine = new Set(shopsOf(g, vis));
      const hits = weekOffers(g)
        .filter((o) => mine.has(o.dealer_id) && (!q || engine.termMatches(q, o.heading, o.description)))
        .sort((a, b) => a.heading.localeCompare(b.heading, 'nb'))
        .slice(0, 300)
        .map(engine.describeOffer);
      return json(200, { offers: hits });
    }

    // Shared settings: only the location (needs ADMIN_CODE). Shops are per visitor
    // (/api/shops); the Kassalapp key is server config (KASSAL_KEY), never set here.
    if (m === 'PUT' && p === '/api/settings') {
      const b = await readJson(req);
      checkAdmin(b.adminCode);
      const g = await global();
      const s = { ...g.settings };
      if (b.location) {
        const lat = Number(b.location.lat), lng = Number(b.location.lng), radiusKm = Number(b.location.radiusKm);
        if (!(lat >= 57 && lat <= 72 && lng >= 4 && lng <= 32)) throw httpError(400, 'Location must be in Norway');
        if (!(radiusKm >= 1 && radiusKm <= 100)) throw httpError(400, 'Radius must be 1–100 km');
        s.location = { name: str(b.location.name, 60) || 'Custom', lat, lng, radiusKm };
      }
      await saveGlobal('settings', s);
      background(work({ budgetMs: 8000 }));
      return state(req, vis);
    }

    // This browser's shops: { shops: [dealer ids] }. Choosing a chain that isn't fetched
    // yet (one of the "other chains") adds it to the weekly fetch.
    if (m === 'PUT' && p === '/api/shops') {
      const b = await readJson(req);
      if (!Array.isArray(b.shops)) throw httpError(400, 'shops must be a list');
      const g = await global();
      const known = new Set(allDealers(g).map((d) => d.id));
      const shops = [...new Set(b.shops.map(String).filter((id) => known.has(id)))];
      const saved = await saveVisitor(req, vis, { shops });
      const fetched = new Set(fetchShops(g));
      const extra = shops.filter((id) => !fetched.has(id));
      if (extra.length) {
        await saveGlobal('flags', { ...g.flags, wantedShops: [...(g.flags.wantedShops || []), ...extra] });
        await markKassalDirty();
        background(work({ budgetMs: 8000 }));
      }
      return state(req, saved.v, 200, saved.headers);
    }

    if (m === 'POST' && p === '/api/items') {
      const b = await readJson(req);
      if (vis.items.length >= MAX_ITEMS) throw httpError(400, 'Too many tracked items');
      const item = cleanItem(b, crypto.randomUUID(), vis.items);
      const saved = await saveVisitor(req, vis, { items: [...vis.items, item] });
      await markKassalDirty();
      background(work({ budgetMs: 8000 }));
      return state(req, saved.v, 201, saved.headers);
    }

    // Bulk delete: { ids: [...] }
    if (m === 'POST' && p === '/api/items/delete') {
      const b = await readJson(req);
      const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : []);
      if (!ids.size) throw httpError(400, 'No items selected');
      if (!vis.id) return state(req, vis);
      const saved = await saveVisitor(req, vis, { items: vis.items.filter((i) => !ids.has(i.id)) });
      return state(req, saved.v, 200, saved.headers);
    }

    const im = p.match(/^\/api\/items\/([\w-]+)$/);
    if (im && (m === 'PUT' || m === 'DELETE')) {
      const idx = vis.items.findIndex((i) => i.id === im[1]);
      if (idx < 0) throw httpError(404, 'No such item');
      const b = await readJson(req);
      const items = [...vis.items];
      if (m === 'PUT') items[idx] = cleanItem(b, im[1], items);
      else items.splice(idx, 1);
      const saved = await saveVisitor(req, vis, { items });
      if (m === 'PUT') { await markKassalDirty(); background(work({ budgetMs: 8000 })); }
      return state(req, saved.v, 200, saved.headers);
    }

    throw httpError(404, 'Not found');
  }

  async function handle(req, { background = (p) => p } = {}) {
    try {
      return await api(req, (p) => background(Promise.resolve(p).catch((e) => log('background work failed:', e.message))));
    } catch (e) {
      const known = typeof e.code === 'number';
      if (!known) log('error:', e.stack || e.message);
      return json(known ? e.code : 500, { error: known ? e.message : 'Internal error' });
    }
  }

  // Build the view cache before the first request (Pi start-up).
  async function warm() { await global(); }

  return { handle, work, warm };
}

module.exports = { createApp, OFFERS_CACHE_V };
