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
  state = s;
  renderStatus(); renderDeals(); renderItems(); renderSettings();
  clearTimeout(pollTimer);
  if (s.status.refreshing || s.status.kassalRefreshing) pollTimer = setTimeout(load, 3000);
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
    el.innerHTML = `<div class="panel empty"><p><b>No tracked items yet.</b></p><p>Add the groceries you buy under <a href="#items" data-go="items">Tracked items</a>, or find some under <a href="#browse" data-go="browse">Browse offers</a>.</p></div>`;
  } else if (!result.shops.length) {
    el.innerHTML = `<div class="panel empty">${status.refreshing ? 'Fetching offers…' : 'None of your tracked items has a qualifying deal this week.'}</div>`;
  } else {
    const count = result.shops.reduce((a, s) => a + s.items.length, 0);
    const saved = result.shops.reduce((a, s) => a + s.items.reduce((b, i) => b + (i.regular.price - i.price), 0), 0);
    el.innerHTML = `<div class="deals-bar">
        <span><span class="nb"><b>${count}</b> deal${count === 1 ? '' : 's'} in ${result.shops.length} shop${result.shops.length === 1 ? '' : 's'}</span>
          <span class="nb muted">· save up to ${kr(saved)}</span></span>
        <button id="expand-all" class="btn ghost small" type="button">Expand all</button>
      </div>` + result.shops.map(shopHtml).join('');
    syncExpandAll();
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
    ? result.dropped.map((d) => `<div class="dropped-row"><b>${esc(d.heading)}</b> · <span class="nb">${esc(d.shop)}</span> · <span class="nb">${kr(d.price)}</span> <span class="chip">${esc(d.tracked)}</span><br><span class="muted">${esc(d.reason)}</span></div>`).join('')
    : '<p class="muted small">Nothing dropped.</p>';
}

function shopHtml(shop) {
  const total = shop.items.reduce((a, i) => a + (i.regular.price - i.price), 0);
  return `<details class="shop" open>
    <summary>
      ${shop.logo ? `<img class="logo" src="${esc(shop.logo)}" alt="" loading="lazy">` : ''}
      <span class="name">${esc(shop.name)}</span>
      <span class="total">${shop.items.length} item${shop.items.length === 1 ? '' : 's'} · save ${kr(total)}</span>
    </summary>
    <div class="shop-items">${shop.items.map((i) => dealHtml(shop, i)).join('')}</div>
  </details>`;
}

// Compact by default: each deal is a two-line row (name, price, discount, regular
// price, unit price, end date). Tapping the row opens the details: image, flyer
// text, where the regular price comes from, and the tracked item it matched.
// Which rows are open survives re-renders.
const openDeals = new Set();
const dealKey = (shop, i) => `${shop.key}:${i.id}`;

function dealHtml(shop, i) {
  const key = dealKey(shop, i);
  const open = openDeals.has(key);
  const starts = new Date(i.runFrom) > new Date();
  const desc = i.description ? i.description.replace(/\s*\n\s*/g, ' · ') : '';
  return `<div class="deal${open ? ' open' : ''}" data-key="${esc(key)}">
    <button class="d-head" type="button" aria-expanded="${open}">
      <span class="d-title">${esc(i.heading)}</span>
      <span class="d-price">${kr(i.price)}</span>
      <span class="d-sub">
        <span class="nb">Regular <s>${kr(i.regular.price)}</s></span>
        <span class="nb">${kr(i.unitPrice)}/${esc(i.unit)}</span>
        <span class="nb">${starts ? 'from ' + day.format(new Date(i.runFrom)) + ', ' : ''}until ${day.format(new Date(i.runTill))}</span>
      </span>
      <span class="save">−${i.savingsPct}%</span>
    </button>
    <div class="d-detail"${open ? '' : ' hidden'}>
      ${i.image ? `<img class="d-img" src="${esc(i.image)}" alt="" loading="lazy">` : ''}
      <div class="d-body">
        ${desc ? `<div class="desc">${esc(desc)}</div>` : ''}
        <div class="ref"><span class="nb">Regular price: ${kr(i.regular.price)}</span> <span class="nb muted">(${kr(i.regular.unitPrice)}/${esc(i.unit)})</span></div>
        <div class="src">${esc(i.regular.source)}</div>
        <div class="meta-row"><span class="muted small">Tracked as</span>${i.trackedItems.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
      </div>
    </div>
  </div>`;
}

function setDealOpen(el, open) {
  el.classList.toggle('open', open);
  el.querySelector('.d-head').setAttribute('aria-expanded', String(open));
  el.querySelector('.d-detail').hidden = !open;
  open ? openDeals.add(el.dataset.key) : openDeals.delete(el.dataset.key);
}
function syncExpandAll() {
  const btn = $('#expand-all');
  if (!btn) return;
  const all = document.querySelectorAll('#deals .deal');
  const allOpen = all.length > 0 && [...all].every((d) => d.classList.contains('open'));
  btn.textContent = allOpen ? 'Collapse all' : 'Expand all';
  btn.dataset.open = String(allOpen);
}
$('#deals').addEventListener('click', (e) => {
  const head = e.target.closest('.d-head');
  if (head) {
    const deal = head.parentElement;
    setDealOpen(deal, !deal.classList.contains('open'));
    return syncExpandAll();
  }
  const btn = e.target.closest('#expand-all');
  if (btn) {
    const open = btn.dataset.open !== 'true';
    document.querySelectorAll('#deals .deal').forEach((d) => setDealOpen(d, open));
    if (open) document.querySelectorAll('#deals details.shop').forEach((s) => { s.open = true; });
    syncExpandAll();
  }
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
async function browse() {
  const q = $('#q').value.trim();
  const el = $('#browse');
  try {
    const { offers } = await call('GET', '/api/offers?q=' + encodeURIComponent(q));
    el.innerHTML = offers.length ? offers.map((o) => `<div class="offer">
      ${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy">` : '<div></div>'}
      <div>
        <div class="title">${esc(o.heading)}</div>
        <div class="desc">${esc(o.description)}</div>
        <div class="foot"><span><b class="nb">${kr(o.price)}</b> <span class="muted small"><span class="nb">${esc(o.shop)}</span>${o.prePrice ? ` · <span class="nb">før ${kr(o.prePrice)}</span>` : ''}</span></span>
          <button class="btn ghost small" data-track="${esc(o.heading)}">+ Track</button></div>
      </div></div>`).join('') : '<p class="muted">No offers match.</p>';
  } catch (err) { el.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
}
$('#browse').addEventListener('click', (e) => {
  const b = e.target.closest('[data-track]');
  if (!b) return;
  const name = b.dataset.track.toLowerCase().replace(/\s+/g, ' ').trim();
  fillItemForm({ id: '', name: name.charAt(0).toUpperCase() + name.slice(1), terms: [name], exclude: [] });
  show('items');
  $('#item-form').name.focus();
});

// ---- settings ----
function renderSettings() {
  const { location, shops, kassalKeySet } = state.settings;
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
  const st = state.status;
  $('#kassal-state').innerHTML = kassalKeySet
    ? (st.kassalError ? `⚠️ ${esc(st.kassalError)}` : `✅ Key set${st.kassalRefreshing ? ' · looking up prices…' : ` · prices cached for ${st.kassalItems} item(s)`}`)
    : 'No key set. Reference prices come from the flyers only.';
}

$('#loc-form').preset.addEventListener('change', (e) => {
  const c = CITIES.find(([n]) => n === e.target.value);
  if (c) { e.target.form.lat.value = c[1]; e.target.form.lng.value = c[2]; }
});
$('#loc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    setState(await call('PUT', '/api/settings', { location: { name: f.preset.value || 'Custom', lat: f.lat.value, lng: f.lng.value, radiusKm: f.radiusKm.value } }));
    toast('Location saved. Fetching offers…');
  } catch (err) { toast(err.message); }
});
$('#shops-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const shops = [...e.target.querySelectorAll('input[name=shop]:checked')].map((i) => i.value);
  try { setState(await call('PUT', '/api/settings', { shops })); toast('Shops saved'); } catch (err) { toast(err.message); }
});
$('#kassal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = e.target.key.value.trim();
  if (!key) return toast('Paste a key first');
  try { setState(await call('PUT', '/api/settings', { kassalKey: key })); e.target.key.value = ''; toast('Key saved. Looking up regular prices…'); } catch (err) { toast(err.message); }
});
$('#kassal-clear').addEventListener('click', async () => {
  try { setState(await call('PUT', '/api/settings', { kassalKey: '' })); toast('Key removed'); } catch (err) { toast(err.message); }
});

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
