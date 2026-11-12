'use strict';
// The app core: API routes, accounts and sessions, and the offer/Kassalapp refresh.
// Host-neutral: it takes a web-standard Request and returns a Response, and stores
// everything through lib/store.js. server.js runs it on the Pi (JSON files);
// netlify/functions/*.mjs run it on Netlify (Blobs).
//
// Data model:
//   settings          shared: location, shops, Kassalapp key (admins edit it)
//   offers            shared: this week's offers per shop (OFFERS_CACHE_V)
//   kassal            shared: Kassalapp products per search-term set, so users who
//                     track the same thing share one lookup
//   flags             small markers: kassalDirtyAt, sessionsCleanedAt
//   users/<name>      account: password hash and the user's tracked items
//   sessions/<sha256> session token hash -> { user, exp }; the token is only in the cookie

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const engine = require('./engine');
const tjek = require('./tjek');
const kassal = require('./kassal');

const scrypt = promisify(crypto.scrypt);

// Bump when the stored offer shape changes (tjek.slim). v2 added `url`; v3 stores the
// fetch time per shop, so a weekly fetch can be split over several short runs (Netlify).
const OFFERS_CACHE_V = 3;
const DEFAULT_SETTINGS = {
  location: { name: 'Oslo', lat: 59.9139, lng: 10.7522, radiusKm: 10 },
  shops: tjek.GROCERY_DEALERS.map((d) => d.id),
  kassalKey: '',
};
const COOKIE = 'tt_session';
const SESSION_MS = 90 * 864e5;
const VIEW_TTL = 5 * 60e3;   // "this week" and the next fetch move with the clock
const MAX_ITEMS = 200;
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;

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

// N=2^14 is ~50 ms on a laptop and about a second on the Pi: fine for logins only.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
async function hashPassword(pw, salt = crypto.randomBytes(16).toString('base64')) {
  return { salt, hash: (await scrypt(pw, salt, 32, SCRYPT)).toString('base64') };
}

function createApp({ store, env = process.env, globalTtlMs = Infinity, log = (...a) => console.log(new Date().toISOString(), ...a) }) {
  const FETCH_WEEKDAY = Number(env.FETCH_WEEKDAY || 1);
  const FETCH_HOUR = Number(env.FETCH_HOUR || 1);
  const slots = () => engine.fetchSlots(Date.now(), FETCH_WEEKDAY, FETCH_HOUR);
  const fetchDisabled = Boolean(env.DISABLE_FETCH);  // set in CI and tests to avoid calling external APIs
  const admins = new Set(String(env.ADMINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const signupCode = String(env.SIGNUP_CODE || '');
  const maxUsers = Number(env.MAX_USERS || 100);
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
  const isAdmin = (u) => (admins.size ? admins.has(u.name) : Boolean(u.firstUser));

  function allDealers(g) {
    const m = new Map(tjek.GROCERY_DEALERS.map((d) => [d.id, { ...d, grocery: true }]));
    for (const d of g.offers.discovered || []) if (!m.has(d.id)) m.set(d.id, { ...d, grocery: false });
    return [...m.values()];
  }
  const dealerName = (g, id) => (allDealers(g).find((d) => d.id === id) || { name: id }).name;

  let weekCache = { key: null };
  function weekOffers(g) {
    if (weekCache.key !== rev || Date.now() - weekCache.at > VIEW_TTL) {
      const now = Date.now(), end = engine.endOfWeek(now);
      const value = g.settings.shops.flatMap((id) => (g.offers.byDealer[id] || {}).offers || []).filter((o) => engine.isThisWeek(o, now, end));
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
    return s.shops.filter((id) => {
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
    const users = await Promise.all((await store.list('users/')).map((k) => store.get(k)));
    return users.filter(Boolean).flatMap((u) => u.items || []);
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

  async function cleanSessions() {
    const g = await global();
    if ((g.flags.sessionsCleanedAt || 0) >= slots().last) return;
    for (const k of await store.list('sessions/')) {
      const s = await store.get(k);
      if (!s || s.exp < Date.now()) await store.del(k);
    }
    await saveGlobal('flags', { ...G.flags, sessionsCleanedAt: Date.now() });
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
        .then(() => cleanSessions().catch((e) => log('session cleanup failed:', e.message)))
        .finally(() => { workP = null; });
    }
    return workP;
  }

  async function markKassalDirty() {
    const g = await global();
    if (kassalKeyOf(g.settings)) await saveGlobal('flags', { ...g.flags, kassalDirtyAt: Date.now() });
  }

  // ---- accounts and sessions ----------------------------------------------------
  const userKey = (name) => `users/${name}`;
  const sessionKey = (token) => `sessions/${sha256(token).toString('hex')}`;

  async function sessionUser(req) {
    const token = readCookie(req, COOKIE);
    if (!token || !/^[\w-]{40,64}$/.test(token)) return null;
    const s = await store.get(sessionKey(token));
    if (!s || s.exp < Date.now()) return null;
    return store.get(userKey(s.user));
  }

  function cookieHeader(req, value, maxAgeSec) {
    const https = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
  }

  async function startSession(req, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    await store.set(sessionKey(token), { user: user.name, exp: Date.now() + SESSION_MS });
    return cookieHeader(req, token, SESSION_MS / 1000);
  }

  // Slows password guessing: a short lockout after repeated failures per username.
  // Per process (on Netlify per function instance); scrypt's cost does the rest.
  const failures = new Map();
  function checkRate(name) {
    const f = failures.get(name);
    if (f && f.n >= 10 && Date.now() - f.at < 15 * 60e3) throw httpError(429, 'Too many attempts. Try again in 15 minutes.');
  }
  function noteFailure(name) {
    const f = failures.get(name);
    failures.set(name, { n: f && Date.now() - f.at < 15 * 60e3 ? f.n + 1 : 1, at: Date.now() });
    if (failures.size > 1000) failures.delete(failures.keys().next().value);
  }

  const DUMMY = hashPassword('x'.repeat(12));  // so unknown usernames take as long as wrong passwords
  async function verifyPassword(user, pw) {
    const ref = user || await DUMMY;
    const { hash } = await hashPassword(pw, ref.salt);
    return Boolean(user) && crypto.timingSafeEqual(Buffer.from(hash, 'base64'), Buffer.from(ref.hash, 'base64'));
  }

  function credentials(b) {
    const name = str(b.username, 40).toLowerCase();
    const password = String(b.password == null ? '' : b.password);
    if (!name || !password) throw httpError(400, 'Username and password are required');
    if (password.length > 200) throw httpError(400, 'Password is too long');
    return { name, password };
  }

  async function register(req) {
    const b = await readJson(req);
    const { name, password } = credentials(b);
    if (!USERNAME_RE.test(name)) throw httpError(400, 'Username: 3–32 characters, letters, digits, . _ or -');
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    if (signupCode && !safeEqual(str(b.code, 200), signupCode)) throw httpError(403, 'Wrong sign-up code');
    if (await store.get(userKey(name))) throw httpError(409, 'That username is taken');
    const existing = await store.list('users/');
    if (existing.length >= maxUsers) throw httpError(403, 'Sign-up is closed');

    // The first account inherits the items tracked before accounts existed (Pi upgrade).
    const g = await global();
    let items = [];
    if (!existing.length && Array.isArray(g.settings.trackedItems)) {
      items = g.settings.trackedItems;
      const { trackedItems, ...rest } = g.settings;
      await saveGlobal('settings', rest);
    }
    const user = { name, ...(await hashPassword(password)), createdAt: Date.now(), firstUser: !existing.length, items, rev: 1 };
    await store.set(userKey(name), user);
    if (items.length) await markKassalDirty();
    log(`account created: ${existing.length + 1} accounts`);
    return state(req, user, 201, { 'Set-Cookie': await startSession(req, user) });
  }

  async function login(req) {
    const { name, password } = credentials(await readJson(req));
    checkRate(name);
    const user = USERNAME_RE.test(name) ? await store.get(userKey(name)) : null;
    if (!(await verifyPassword(user, password))) {
      noteFailure(name);
      throw httpError(401, 'Wrong username or password');
    }
    failures.delete(name);
    return state(req, user, 200, { 'Set-Cookie': await startSession(req, user) });
  }

  async function logout(req) {
    await readJson(req);
    const token = readCookie(req, COOKIE);
    if (token && /^[\w-]{40,64}$/.test(token)) await store.del(sessionKey(token));
    return state(req, null, 200, { 'Set-Cookie': cookieHeader(req, '', 0) });
  }

  async function changePassword(req, user) {
    const b = await readJson(req);
    const current = String(b.current || ''), next = String(b.next || '');
    checkRate(user.name);
    if (!(await verifyPassword(user, current))) { noteFailure(user.name); throw httpError(403, 'Current password is wrong'); }
    if (next.length < 8 || next.length > 200) throw httpError(400, 'New password must be 8–200 characters');
    await saveUser({ ...user, ...(await hashPassword(next)) });
    return json(200, { ok: true });
  }

  async function saveUser(user) {
    const u = { ...user, rev: (user.rev || 0) + 1 };
    await store.set(userKey(u.name), u);
    return u;
  }

  // ---- view -----------------------------------------------------------------

  function stateView(g, user) {
    const s = g.settings;
    const offers = weekOffers(g);
    const key = kassalKeyOf(s);
    const shopKeys = s.shops.map((id) => engine.shopKey(dealerName(g, id)));
    const kassalData = {};
    if (key) {
      for (const item of user.items) {
        const e = g.kassal.entries[termsKeyFor(item, offers)];
        if (e) kassalData[item.id] = e.products;
      }
    }
    const result = engine.compute({ offers, trackedItems: user.items, shopKeys, kassal: kassalData, kassalEnabled: Boolean(key) });
    const fetchedAt = Math.max(0, ...s.shops.map((id) => (g.offers.byDealer[id] || {}).at || 0));
    return {
      user: { name: user.name, admin: isAdmin(user) },
      settings: {
        location: s.location,
        shops: s.shops,
        trackedItems: user.items,
        kassalKeySet: Boolean(key),
        kassalKeyFromEnv: !s.kassalKey && Boolean(envKassalKey),
      },
      dealers: allDealers(g),
      status: {
        refreshing: working.offers || (!fetchDisabled && dealersToFetch(g).length > 0),
        kassalRefreshing: working.kassal || (!fetchDisabled && kassalPending(g)),
        kassalError: g.kassal.error,
        fetchedAt,
        nextFetch: slots().next,
        offerCount: offers.length,
        weekEnds: engine.endOfWeek(Date.now()),
        errors: Object.entries(g.offers.errors).filter(([id]) => id === '_discovery' || s.shops.includes(id)).map(([, m]) => m),
        kassalItems: Object.keys(g.kassal.entries).length,
      },
      result,
    };
  }

  // Serialised once per change per user, with an ETag so an unchanged reload gets a 304.
  const views = new Map();  // user name -> { key, at, body, etag }
  async function stateBody(user) {
    const g = await global();
    const k = `${rev}|${user.rev}|${working.offers}|${working.kassal}`;
    let v = views.get(user.name);
    if (!v || v.key !== k || Date.now() - v.at > VIEW_TTL) {
      const body = JSON.stringify(stateView(g, user));
      v = { key: k, at: Date.now(), body, etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"` };
      views.delete(user.name);
      views.set(user.name, v);
      if (views.size > 200) views.delete(views.keys().next().value);
    }
    return v;
  }

  // nginx turns our ETag into a weak one (W/"...") when it gzips the response.
  function etagMatches(req, etag) {
    const inm = req.headers.get('if-none-match');
    return Boolean(inm) && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
  }

  async function state(req, user, code = 200, extra = {}) {
    if (!user) return json(code, { user: null, signup: { codeRequired: Boolean(signupCode) } }, { Vary: 'Cookie', ...extra });
    const { body, etag } = await stateBody(user);
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

    if (m === 'POST' && p === '/api/auth/register') return register(req);
    if (m === 'POST' && p === '/api/auth/login') return login(req);
    if (m === 'POST' && p === '/api/auth/logout') return logout(req);

    const user = await sessionUser(req);
    if (m === 'GET' && p === '/api/state') return state(req, user);
    if (!user) throw httpError(401, 'Please log in');

    if (m === 'POST' && p === '/api/auth/password') return changePassword(req, user);

    if (m === 'GET' && p === '/api/offers') {
      // Same word rules as tracked items, so a search here previews what a term would match.
      const q = engine.norm(url.searchParams.get('q')).slice(0, 100);
      const hits = weekOffers(await global())
        .filter((o) => !q || engine.termMatches(q, o.heading, o.description))
        .sort((a, b) => a.heading.localeCompare(b.heading, 'nb'))
        .slice(0, 300)
        .map(engine.describeOffer);
      return json(200, { offers: hits });
    }

    if (m === 'PUT' && p === '/api/settings') {
      if (!isAdmin(user)) throw httpError(403, 'Only an admin can change shared settings');
      const b = await readJson(req);
      const g = await global();
      const s = { ...g.settings };
      if (b.location) {
        const lat = Number(b.location.lat), lng = Number(b.location.lng), radiusKm = Number(b.location.radiusKm);
        if (!(lat >= 57 && lat <= 72 && lng >= 4 && lng <= 32)) throw httpError(400, 'Location must be in Norway');
        if (!(radiusKm >= 1 && radiusKm <= 100)) throw httpError(400, 'Radius must be 1–100 km');
        s.location = { name: str(b.location.name, 60) || 'Custom', lat, lng, radiusKm };
      }
      if (Array.isArray(b.shops)) {
        const known = new Set(allDealers(g).map((d) => d.id));
        s.shops = [...new Set(b.shops.filter((id) => known.has(id)))];
      }
      if (typeof b.kassalKey === 'string') {
        s.kassalKey = str(b.kassalKey, 200);
        await saveGlobal('kassal', emptyKassal());
      }
      await saveGlobal('settings', s);
      background(work({ budgetMs: 8000 }));
      return state(req, user);
    }

    if (m === 'POST' && p === '/api/items') {
      const b = await readJson(req);
      if (user.items.length >= MAX_ITEMS) throw httpError(400, 'Too many tracked items');
      const item = cleanItem(b, crypto.randomUUID(), user.items);
      const u = await saveUser({ ...user, items: [...user.items, item] });
      await markKassalDirty();
      background(work({ budgetMs: 8000 }));
      return state(req, u, 201);
    }

    // Bulk delete: { ids: [...] }
    if (m === 'POST' && p === '/api/items/delete') {
      const b = await readJson(req);
      const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : []);
      if (!ids.size) throw httpError(400, 'No items selected');
      const u = await saveUser({ ...user, items: user.items.filter((i) => !ids.has(i.id)) });
      return state(req, u);
    }

    const im = p.match(/^\/api\/items\/([\w-]+)$/);
    if (im && (m === 'PUT' || m === 'DELETE')) {
      const idx = user.items.findIndex((i) => i.id === im[1]);
      if (idx < 0) throw httpError(404, 'No such item');
      const b = await readJson(req);
      const items = [...user.items];
      if (m === 'PUT') items[idx] = cleanItem(b, im[1], items);
      else items.splice(idx, 1);
      const u = await saveUser({ ...user, items });
      if (m === 'PUT') { await markKassalDirty(); background(work({ budgetMs: 8000 })); }
      return state(req, u);
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
