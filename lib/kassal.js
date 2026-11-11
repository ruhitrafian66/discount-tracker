'use strict';
// Kassalapp (kassal.app): Norwegian shelf prices per chain, with price history.
// Optional: needs a free API key (Bearer). Free tier is rate-limited (~60 req/min),
// so requests are spaced out and results are cached per tracked item.

const BASE = 'https://kassal.app/api/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(apiKey, query) {
  const url = `${BASE}/products?${new URLSearchParams({ search: query, size: 100 })}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) return (await res.json()).data || [];
    if (res.status === 429 && attempt < 3) { await sleep(15000 * (attempt + 1)); continue; }
    const body = await res.text().catch(() => '');
    const err = new Error(`Kassalapp HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
}

// One search per term (Kassalapp needs >= 3 chars), merged and de-duplicated.
// `terms` are already spelling-corrected and stripped of '*' (engine.searchTerms).
async function productsForTerms(apiKey, terms) {
  const byId = new Map();
  for (const t of terms) {
    for (const p of await search(apiKey, t)) byId.set(p.id, slim(p));
    await sleep(1100);
  }
  return [...byId.values()];
}

function slim(p) {
  const store = Array.isArray(p.store) ? p.store[0] : p.store;
  return {
    id: p.id, name: p.name, brand: p.brand, ean: p.ean,
    store: store ? { name: store.name, code: store.code } : null,
    categories: (p.category || []).map((c) => c.name),
    current_price: p.current_price, weight: p.weight, weight_unit: p.weight_unit,
    price_history: (p.price_history || []).slice(0, 120).map((h) => ({ price: h.price, date: h.date })),
  };
}

module.exports = { productsForTerms };
