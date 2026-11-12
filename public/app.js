'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nok = new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kr = (n) => nok.format(n);
const day = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Oslo' });
const dateTime = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });

const CITIES = [
  ['Oslo', 59.9139, 10.7522], ['Bergen', 60.3913, 5.3221], ['Trondheim', 63.4305, 10.3951],
  ['Stavanger', 58.9700, 5.7331], ['Kristiansand', 58.1467, 7.9956], ['Tromsø', 69.6492, 18.9553],
  ['Drammen', 59.7439, 10.2045], ['Fredrikstad', 59.2181, 10.9298], ['Bodø', 67.2804, 14.4049],
  ['Ålesund', 62.4722, 6.1495], ['Lillestrøm', 59.9560, 11.0492], ['Bærum (Sandvika)', 59.8910, 10.5240],
];

let state = null;
let pollTimer = null;
let pollDelay = 3000;

async function call(method, url, body) {
  const opts = { method, headers: {} };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}

async function load() {
  try {
    setState(await call('GET', '/api/state'));
  } catch (e) {
    $('#status').textContent = 'Could not reach the server: ' + e.message;
  }
}

function setState(s) {
  clearTimeout(pollTimer);
  state = s;
  renderStatus(); renderDeals(); renderItems(); renderSettings();
  // While a fetch is pending, poll; back off, since on Netlify the work may wait
  // for the next scheduled run.
  if (s.status.refreshing || s.status.kassalRefreshing) {
    pollTimer = setTimeout(load, pollDelay);
    pollDelay = Math.min(pollDelay * 1.5, 60000);
  } else pollDelay = 3000;
}

// ---- status ----
function renderStatus() {
  const st = state.status;
  // Each part stays on one line; wrapping only happens between parts.
  const parts = [];
  if (st.refreshing) parts.push('Fetching offers…');
  else if (st.fetchedAt) parts.push(`${st.offerCount} offers this week`, `fetched ${dateTime.format(new Date(st.fetchedAt))}`);
  else parts.push('No offers fetched yet');
  if (st.kassalRefreshing) parts.push('looking up regular prices…');
  parts.push(`next update ${dateTime.format(new Date(st.nextFetch))}`);
  parts.push(`${state.settings.location.name} +${state.settings.location.radiusKm} km`);
  $('#status').innerHTML = parts.map((p) => `<span class="nb">${esc(p)}</span>`).join('<span class="sep" aria-hidden="true"> · </span>');
}

// ---- deals ----
function renderDeals() {
  const { result, settings, status } = state;
  const el = $('#deals');
  if (!settings.trackedItems.length) {
    el.innerHTML = `<div class="panel empty"><div class="empty-icon" aria-hidden="true">🛒</div><p><b>No tracked items yet.</b></p><p>Add the groceries you buy under <a href="#items" data-go="items">Tracked items</a>, or find some under <a href="#browse" data-go="browse">Browse offers</a>.</p></div>`;
  } else if (!result.shops.length) {
    el.innerHTML = `<div class="panel empty"><div class="empty-icon" aria-hidden="true">${status.refreshing ? '⏳' : '🔎'}</div><p>${status.refreshing ? 'Fetching offers…' : 'None of your tracked items has a qualifying deal this week.'}</p></div>`;
  } else {
    const count = result.shops.reduce((a, s) => a + s.items.length, 0);
    const saved = result.shops.reduce((a, s) => a + s.saved, 0);
    el.innerHTML = `<div class="hero">
        <div><div class="hero-label">You can save this week</div><div class="hero-num nb">${kr(saved)}</div></div>
        <div class="hero-stats">
          <div><b>${count}</b><span>deal${count === 1 ? '' : 's'}</span></div>
          <div><b>${result.shops.length}</b><span>shop${result.shops.length === 1 ? '' : 's'}</span></div>
        </div>
      </div>
      <p class="deals-hint">Tap a deal for the flyer, regular price and details.</p>` + result.shops.map(shopHtml).join('');
  }

  const missing = result.summary.filter((s) => s.candidates === 0).map((s) => s.name);
  if (missing.length && settings.trackedItems.length) {
    el.insertAdjacentHTML('beforeend', `<p class="muted small">No offers this week for: ${missing.map(esc).join(', ')}</p>`);
  }
  if (status.errors && status.errors.length) {
    el.insertAdjacentHTML('beforeend', `<p class="muted small">Some shops failed to load: ${status.errors.map(esc).join('; ')}</p>`);
  }

  $('#dropped-count').textContent = result.dropped.length;
  $('#dropped').innerHTML = result.dropped.length
    ? result.dropped.map((d, n) => `<button class="dropped-row" type="button" aria-haspopup="dialog" data-drop="${n}"><b>${esc(d.heading)}</b> · <span class="nb">${esc(d.shop)}</span> · <span class="nb">${kr(d.price)}</span> <span class="chip">${esc(d.tracked)}</span><br><span class="muted">${esc(d.reason)}</span></button>`).join('')
    : '<p class="muted small">Nothing dropped.</p>';
}

// The chain's brand colour tints its card. It comes from the offer API, so only a
// plain 6-digit hex is accepted; near-white colours (REMA 1000) keep the app green.
function brandStyle(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return '';
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  if (0.2126 * r + 0.7152 * g + 0.0722 * b > 225) return '';
  return ` style="--brand:#${m[1]}"`;
}

function shopHtml(shop) {
  return `<details class="shop" open${brandStyle(shop.color)}>
    <summary>
      ${shop.logo ? `<img class="logo" src="${esc(shop.logo)}" alt="" loading="lazy">` : ''}
      <span class="who"><span class="name">${esc(shop.name)}</span><span class="count">${shop.items.length} deal${shop.items.length === 1 ? '' : 's'}</span></span>
      <span class="total">save ${kr(shop.saved)}</span>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </summary>
    <div class="shop-items">${shop.items.map((i) => dealHtml(shop, i)).join('')}</div>
  </details>`;
}

// Each deal is a compact two-line row (name, price, discount, regular price,
// unit price, end date). Tapping it opens the deal in a popup with the image,
// flyer text, regular-price source, tracked item and a link to the flyer.
const dealKey = (shop, i) => `${shop.key}:${i.id}`;

function dealHtml(shop, i) {
  const starts = new Date(i.runFrom) > new Date();
  return `<div class="deal">
    <button class="d-head" type="button" aria-haspopup="dialog" data-key="${esc(dealKey(shop, i))}">
      <span class="d-title">${esc(i.heading)}</span>
      <span class="d-price">${kr(i.price)}</span>
      <span class="d-sub">
        <span class="nb">Regular <s>${kr(i.regular.price)}</s></span>
        <span class="nb">${kr(i.unitPrice)}/${esc(i.unit)}</span>
        <span class="nb">${starts ? 'from ' + day.format(new Date(i.runFrom)) + ', ' : ''}until ${day.format(new Date(i.runTill))}</span>
      </span>
      <span class="save">−${i.savingsPct}%</span>
    </button>
  </div>`;
}

function findDeal(key) {
  for (const shop of state.result.shops) {
    for (const i of shop.items) if (dealKey(shop, i) === key) return { ...i, shop: shop.name, logo: shop.logo };
  }
  return null;
}

// Links come from our own server, but they end up in an href: only allow https.
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);

// One popup for every offer in the app: a shown deal, a dropped offer, a browse result.
//   o       the offer (shop, logo, heading, image, price, unitPrice, unit, regular|null, runFrom, runTill, description, url)
//   tracked names of the tracked items it matched (deals, dropped)
//   reason  why it is not shown on the Deals page (dropped)
//   track   heading to start tracking from (browse)
function showOffer(o, { tracked = [], reason = '', track = '' } = {}) {
  const url = safeUrl(o.url);
  const reg = o.regular;
  const saves = reg && reg.price > o.price;
  const dlg = $('#deal-dialog');
  dlg.innerHTML = `
    <div class="dd-top">
      ${o.logo ? `<img class="logo" src="${esc(o.logo)}" alt="">` : ''}
      <span class="dd-shop">${esc(o.shop)}</span>
      <button class="dd-close" type="button" data-close aria-label="Close">✕</button>
    </div>
    <div class="dd-scroll">
      ${reason ? `<div class="dd-reason"><b>Not shown in Deals.</b> ${esc(reason)}</div>` : ''}
      ${o.image ? `<img class="dd-img" src="${esc(o.image)}" alt="">` : ''}
      <h2 id="dd-title">${esc(o.heading)}</h2>
      <div class="dd-price">
        <span class="price">${kr(o.price)}</span>
        ${saves ? `<span class="save">−${Math.round((1 - o.price / reg.price) * 100)}%</span>` : ''}
        <span class="nb muted">${kr(o.unitPrice)}/${esc(o.unit)}</span>
      </div>
      <dl class="dd-facts">
        <dt>Regular price</dt>
        <dd>${reg
          ? `<span class="nb">${kr(reg.price)}</span> <span class="nb muted">(${kr(reg.unitPrice)}/${esc(o.unit)})</span>
             <div class="src">${esc(reg.source)}</div>`
          : '<span class="muted">Not given in the flyer</span>'}</dd>
        ${saves ? `<dt>You save</dt><dd class="nb">${kr(reg.price - o.price)}</dd>` : ''}
        <dt>Valid</dt>
        <dd class="nb">${day.format(new Date(o.runFrom))} – ${day.format(new Date(o.runTill))}</dd>
        ${tracked.length ? `<dt>Tracked as</dt><dd>${tracked.map((t) => `<span class="chip">${esc(t)}</span>`).join(' ')}</dd>` : ''}
      </dl>
      ${o.description ? `<p class="dd-desc">${esc(o.description)}</p>` : ''}
    </div>
    <div class="dd-actions">
      ${url
        ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View in flyer ↗</a>`
        : '<span class="muted small">No flyer link for this offer.</span>'}
      ${track ? `<button class="btn ghost" type="button" data-track="${esc(track)}">+ Track</button>` : ''}
      <button class="btn ghost" type="button" data-close>Close</button>
    </div>`;
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('.dd-scroll').scrollTop = 0;
}

$('#deals').addEventListener('click', (e) => {
  const head = e.target.closest('.d-head');
  if (!head) return;
  const deal = findDeal(head.dataset.key);
  if (deal) showOffer(deal, { tracked: deal.trackedItems });
});
$('#dropped').addEventListener('click', (e) => {
  const row = e.target.closest('[data-drop]');
  const d = row && state.result.dropped[Number(row.dataset.drop)];
  if (d) showOffer(d, { tracked: [d.tracked], reason: d.reason });
});
// Close on the buttons or a click on the backdrop (the dialog element itself). Esc is built in.
$('#deal-dialog').addEventListener('click', (e) => {
  const track = e.target.closest('[data-track]');
  if (track) { e.currentTarget.close(); return startTracking(track.dataset.track); }
  if (e.target.closest('[data-close]') || e.target === e.currentTarget) e.currentTarget.close();
});

// ---- tracked items ----
// Selection for bulk actions, and which delete is awaiting in-page confirmation
// (null, 'bulk', or an item id).
const selected = new Set();
let confirming = null;

function renderItems() {
  const items = state.settings.trackedItems;
  for (const id of [...selected]) if (!items.some((i) => i.id === id)) selected.delete(id);
  if (confirming && confirming !== 'bulk' && !items.some((i) => i.id === confirming)) confirming = null;
  if (confirming === 'bulk' && !selected.size) confirming = null;

  const n = selected.size;
  const all = items.length > 0 && n === items.length;
  $('#items-toolbar').innerHTML = !items.length ? '' : confirming === 'bulk'
    ? `<div class="confirm" role="alertdialog" aria-label="Confirm delete">
        <span>Stop tracking <b>${n}</b> item${n === 1 ? '' : 's'}? This can't be undone.</span>
        <button class="btn danger small" data-act="bulk-yes">Delete ${n}</button>
        <button class="btn ghost small" data-act="cancel">Cancel</button>
      </div>`
    : `<label class="selall"><input type="checkbox" data-act="all"${all ? ' checked' : ''}> Select all</label>
       <span class="muted small">${n ? `${n} selected` : ''}</span>
       <span class="spacer"></span>
       <button class="btn ghost small" data-act="clear"${n ? '' : ' disabled'}>Clear</button>
       <button class="btn danger small" data-act="bulk"${n ? '' : ' disabled'}>Delete selected${n ? ` (${n})` : ''}</button>`;
  const allBox = $('#items-toolbar [data-act="all"]');
  if (allBox) allBox.indeterminate = n > 0 && !all;

  const summary = new Map(state.result.summary.map((s) => [s.id, s]));
  $('#items').innerHTML = items.length ? items.map((it) => {
    const s = summary.get(it.id) || { candidates: 0, shown: 0 };
    const sel = selected.has(it.id);
    const actions = confirming === it.id
      ? `<div class="confirm" role="alertdialog" aria-label="Confirm delete">
          <span>Delete?</span>
          <button class="btn danger small" data-act="del-yes" data-id="${esc(it.id)}">Delete</button>
          <button class="btn ghost small" data-act="cancel">Cancel</button>
        </div>`
      : `<button class="btn ghost small" data-act="edit" data-id="${esc(it.id)}">Edit</button>
         <button class="btn ghost small" data-act="del" data-id="${esc(it.id)}" aria-label="Delete ${esc(it.name)}">✕</button>`;
    return `<div class="item-row${sel ? ' selected' : ''}">
      <input type="checkbox" class="pick" data-act="pick" data-id="${esc(it.id)}"${sel ? ' checked' : ''} aria-label="Select ${esc(it.name)}">
      <div class="grow">
        <div class="name-row"><b>${esc(it.name)}</b> <span class="pill">${s.shown} shown / ${s.candidates} matched</span></div>
        <div class="meta">Terms: ${it.terms.map(esc).join(', ')}${it.exclude.length ? ' · Excludes: ' + it.exclude.map(esc).join(', ') : ''}</div>
      </div>
      ${actions}
    </div>`;
  }).join('') : '<p class="muted">Nothing tracked yet.</p>';
}

function fillItemForm(it) {
  const f = $('#item-form');
  f.id.value = it ? it.id : '';
  f.name.value = it ? it.name : '';
  f.terms.value = it ? it.terms.join(', ') : '';
  f.exclude.value = it ? it.exclude.join(', ') : '';
  $('#item-form-title').textContent = it && it.id ? 'Edit tracked item' : 'Track an item';
  $('#item-cancel').hidden = !(it && it.id);
}

$('#item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value, terms: f.terms.value, exclude: f.exclude.value };
  const btn = f.querySelector('[type=submit]');
  if (btn.disabled) return;
  btn.disabled = true;  // no double submits
  try {
    setState(f.id.value ? await call('PUT', `/api/items/${f.id.value}`, body) : await call('POST', '/api/items', body));
    toast(`Saved "${body.name}"`);
    fillItemForm(null);
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
});
$('#item-cancel').addEventListener('click', () => fillItemForm(null));
async function onItemsAction(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  const items = state.settings.trackedItems;
  switch (act) {
    case 'pick': el.checked ? selected.add(id) : selected.delete(id); confirming = null; break;
    case 'all': if (el.checked) items.forEach((i) => selected.add(i.id)); else selected.clear(); confirming = null; break;
    case 'clear': selected.clear(); confirming = null; break;
    case 'edit': fillItemForm(items.find((i) => i.id === id)); window.scrollTo({ top: 0, behavior: 'smooth' }); return;
    case 'del': confirming = id; break;
    case 'bulk': confirming = 'bulk'; break;
    case 'cancel': confirming = null; break;
    case 'del-yes':
    case 'bulk-yes': {
      const ids = act === 'bulk-yes' ? [...selected] : [id];
      el.disabled = true;
      try {
        const s = await call('POST', '/api/items/delete', { ids });
        ids.forEach((x) => selected.delete(x));
        confirming = null;
        setState(s);
        toast(`Deleted ${ids.length} item${ids.length === 1 ? '' : 's'}`);
      } catch (err) { el.disabled = false; toast(err.message); }
      return;
    }
    default: return;
  }
  renderItems();
  const focus = $(confirming === 'bulk' ? '#items-toolbar [data-act="bulk-yes"]' : `#items [data-act="del-yes"]`);
  if (focus && (act === 'del' || act === 'bulk')) focus.focus();
}
$('#items').addEventListener('click', onItemsAction);
$('#items-toolbar').addEventListener('click', onItemsAction);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && confirming) { confirming = null; renderItems(); }
});

// ---- browse ----
let browseTimer;
$('#q').addEventListener('input', () => { clearTimeout(browseTimer); browseTimer = setTimeout(browse, 250); });
let browseOffers = [];
async function browse() {
  const q = $('#q').value.trim();
  const el = $('#browse');
  try {
    browseOffers = (await call('GET', '/api/offers?q=' + encodeURIComponent(q))).offers;
    el.innerHTML = browseOffers.length ? browseOffers.map((o, n) => `<div class="offer" data-offer="${n}">
      ${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy">` : '<div></div>'}
      <div>
        <button class="title" type="button" aria-haspopup="dialog">${esc(o.heading)}</button>
        <div class="desc">${esc(o.description)}</div>
        <div class="foot"><span><b class="nb">${kr(o.price)}</b> <span class="muted small"><span class="nb">${esc(o.shop)}</span>${o.regular ? ` · <span class="nb">før ${kr(o.regular.price)}</span>` : ''}</span></span>
          <button class="btn ghost small" type="button" data-track="${esc(o.heading)}">+ Track</button></div>
      </div></div>`).join('') : '<p class="muted">No offers match.</p>';
  } catch (err) { browseOffers = []; el.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
}
function startTracking(heading) {
  const name = heading.toLowerCase().replace(/\s+/g, ' ').trim();
  fillItemForm({ id: '', name: name.charAt(0).toUpperCase() + name.slice(1), terms: [name], exclude: [] });
  show('items');
  $('#item-form').name.focus();
}
// Tapping a card opens the popup; the "+ Track" button keeps its own action.
$('#browse').addEventListener('click', (e) => {
  const track = e.target.closest('[data-track]');
  if (track) return startTracking(track.dataset.track);
  const card = e.target.closest('[data-offer]');
  const o = card && browseOffers[Number(card.dataset.offer)];
  if (o) showOffer(o, { track: o.heading });
});

// ---- settings ----
function renderSettings() {
  const { location, shops, adminCodeSet } = state.settings;
  // The location is shared: it needs the admin code, and is read-only without ADMIN_CODE.
  $('#admin-code').closest('label').hidden = !adminCodeSet;
  $('#admin-note').textContent = adminCodeSet
    ? 'The location applies to everyone using this site. Enter the admin code to change it.'
    : 'The location applies to everyone using this site. It is locked: set ADMIN_CODE on the server to change it.';
  $('#loc-form').querySelectorAll('input, select, button').forEach((el) => { el.disabled = !adminCodeSet; });
  const lf = $('#loc-form');
  if (!lf.contains(document.activeElement)) {
    lf.preset.innerHTML = '<option value="">Custom…</option>' + CITIES.map(([n]) => `<option${n === location.name ? ' selected' : ''}>${esc(n)}</option>`).join('');
    lf.lat.value = location.lat; lf.lng.value = location.lng; lf.radiusKm.value = location.radiusKm;
  }
  const sf = $('#shops-form');
  if (!sf.contains(document.activeElement)) {
    const sel = new Set(shops);
    const box = (d) => `<label><input type="checkbox" name="shop" value="${esc(d.id)}"${sel.has(d.id) ? ' checked' : ''}> ${esc(d.name)}</label>`;
    const groc = state.dealers.filter((d) => d.grocery), other = state.dealers.filter((d) => !d.grocery).sort((a, b) => a.name.localeCompare(b.name, 'nb'));
    $('#shops').innerHTML = '<h3>Grocery</h3>' + groc.map(box).join('') + (other.length ? '<h3>Other chains with offers near you</h3>' + other.map(box).join('') : '');
  }
}

// The shared location needs the admin code; it stays in the page, never stored.
function saveSettings(body) {
  return call('PUT', '/api/settings', { ...body, adminCode: $('#admin-code').value });
}

$('#loc-form').preset.addEventListener('change', (e) => {
  const c = CITIES.find(([n]) => n === e.target.value);
  if (c) { e.target.form.lat.value = c[1]; e.target.form.lng.value = c[2]; }
});
$('#loc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    setState(await saveSettings({ location: { name: f.preset.value || 'Custom', lat: f.lat.value, lng: f.lng.value, radiusKm: f.radiusKm.value } }));
    toast('Location saved. Fetching offers…');
  } catch (err) { toast(err.message); }
});
$('#shops-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const shops = [...e.target.querySelectorAll('input[name=shop]:checked')].map((i) => i.value);
  try { setState(await call('PUT', '/api/shops', { shops })); toast('Your shops saved'); } catch (err) { toast(err.message); }
});

// ---- theme ----
// Light by default; the toggle switches to dark and remembers it in this browser.
function applyTheme(dark) {
  const root = document.documentElement;
  if (dark) root.dataset.theme = 'dark'; else delete root.dataset.theme;
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = dark ? '#0e1411' : '#f6efe2';
  const btn = $('#theme-toggle');
  btn.setAttribute('aria-pressed', String(dark));
  btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}
$('#theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  applyTheme(dark);
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* private mode: not remembered */ }
});
applyTheme(document.documentElement.dataset.theme === 'dark');

// ---- tabs ----
function show(view) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  if (view === 'browse' && !$('#browse').children.length) browse();
}
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.view); });
document.addEventListener('click', (e) => { const a = e.target.closest('[data-go]'); if (a) { e.preventDefault(); show(a.dataset.go); } });

show(['deals', 'items', 'browse', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'deals');
load();
