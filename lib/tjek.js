'use strict';
// Tjek "squid" API: the backend behind eTilbudsavis.no and Mattilbud.no.
// Public, no key. Location-scoped. Hard cap of 1000 results per query, so we query per dealer.

const BASE = 'https://squid-api.tjek.com/v2';
const PAGE = 100;
const MAX_OFFSET = 900;

// Norwegian grocery chains (Tjek dealer ids). Pre-selected as shops.
const GROCERY_DEALERS = [
  { id: '257bxm', name: 'KIWI' },
  { id: 'faa0Ym', name: 'REMA 1000' },
  { id: '4333pm', name: 'MENY' },
  { id: '80742m', name: 'Extra' },
  { id: '51dawm', name: 'Obs' },
  { id: 'de79dm', name: 'Coop Mega' },
  { id: 'f5d5lm', name: 'Coop Prix' },
  { id: '68baam', name: 'Coop Marked' },
  { id: 'b3e8Fm', name: 'Joker' },
  { id: 'c062vm', name: 'SPAR' },
  { id: '5b11sm', name: 'Bunnpris' },
  { id: '5861Qq', name: 'Nærbutikken' },
  { id: '2686gD', name: 'Matkroken' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => '');
    if (body.includes('PAGINATION_MAX_REACHED')) return [];
    if (attempt < 2 && (res.status === 429 || res.status >= 500)) { await sleep(2000 * (attempt + 1)); continue; }
    throw new Error(`Tjek ${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

function locParams(loc) {
  return { r_lat: loc.lat, r_lng: loc.lng, r_radius: Math.round(loc.radiusKm * 1000) };
}

async function fetchDealerOffers(dealerId, loc) {
  const out = [];
  for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE) {
    const page = await get('/offers', { dealer_ids: dealerId, ...locParams(loc), limit: PAGE, offset });
    out.push(...page);
    if (page.length < PAGE) break;
    await sleep(250);
  }
  return out;
}

// Chains with offers near the location (sampled), so users can opt into non-grocery shops.
async function discoverDealers(loc) {
  const seen = new Map();
  for (let offset = 0; offset < 500; offset += PAGE) {
    const page = await get('/offers', { ...locParams(loc), limit: PAGE, offset });
    for (const o of page) if (!seen.has(o.dealer_id)) seen.set(o.dealer_id, { id: o.dealer_id, name: o.dealer.name });
    if (page.length < PAGE) break;
    await sleep(250);
  }
  return [...seen.values()];
}

// Public page for an offer on eTilbudsavis (verified 2026-11): the path must be the
// dealer's real market slug ("REMA-1000", "Naerbutikken"); a guessed slug is a 404.
function offerUrl(o) {
  const markets = (o.dealer && o.dealer.markets) || [];
  const market = markets.find((m) => m.country_code === 'NO') || markets[0];
  if (!market || !market.slug || !o.id) return null;
  const q = new URLSearchParams();
  if (o.catalog_id) q.set('publication', o.catalog_id);
  q.set('offer', o.id);
  return `https://etilbudsavis.no/${encodeURIComponent(market.slug)}?${q}`;
}

// Keep only fields the app uses; the raw offers are large.
function slim(o) {
  return {
    id: o.id,
    url: offerUrl(o),
    heading: o.heading,
    description: o.description,
    pricing: o.pricing,
    quantity: o.quantity,
    images: { thumb: o.images && o.images.thumb },
    run_from: o.run_from,
    run_till: o.run_till,
    dealer_id: o.dealer_id,
    dealer: { name: o.dealer.name, logo: o.dealer.logo, color: o.dealer.color },
  };
}

module.exports = { GROCERY_DEALERS, fetchDealerOffers, discoverDealers, slim, offerUrl };
