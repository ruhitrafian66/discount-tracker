'use strict';
// Pure comparison engine: given this week's offers, tracked items and optional
// regular-price data, decide which offers to show per shop and why others drop.
// No I/O here so the rules can be unit-tested.

const norm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

// Chain names differ between sources ("Extra" vs "Coop Extra"); compare on this key.
function shopKey(name) {
  return norm(name).replace(/^coop\s+/, '').replace(/!/g, '').trim();
}

// ---- quantities -----------------------------------------------------------

const UNIT = {
  g: ['kg', 0.001], hg: ['kg', 0.1], kg: ['kg', 1],
  ml: ['l', 0.001], cl: ['l', 0.01], dl: ['l', 0.1], l: ['l', 1],
  pcs: ['stk', 1], piece: ['stk', 1], stk: ['stk', 1],
};

// "18 PK", "80 stk.", "15-pk", "12 egg"
const COUNT_RE = /(?:^|[^\d,.])(\d{1,3})\s*-?\s*(?:stk|pk|pakk|pack|egg)\b/i;

// Total amount an offer's price buys, in base units (kg / l / stk).
// Flyers often encode a pack as "1 pcs"; then we look for the count in the text,
// and if there is none the offer is only comparable per package ('pk').
function offerAmount(offer) {
  const q = offer.quantity || {};
  const sym = q.unit && q.unit.symbol;
  const pieces = Math.max(1, (q.pieces && q.pieces.from) || 1);
  const def = sym && UNIT[sym];
  const from = q.size && q.size.from;
  const to = (q.size && q.size.to) || from;
  if (!def || !(from > 0)) return { dim: 'pk', amount: pieces };
  if (def[0] === 'stk' && from <= 1) {
    const m = COUNT_RE.exec(offer.heading || '') || COUNT_RE.exec(offer.description || '');
    const count = m ? parseInt(m[1], 10) : 0;
    return count > 1 ? { dim: 'stk', amount: count * pieces } : { dim: 'pk', amount: pieces };
  }
  const size = (from + to) / 2;
  return { dim: def[0], amount: size * def[1] * pieces };
}

function productAmount(p) {
  const def = UNIT[p.weight_unit];
  if (!def || !(p.weight > 0)) return null;
  return { dim: def[0], amount: p.weight * def[1] };
}

// ---- regular price of an offer ------------------------------------------

const NUM = '(\\d{1,5}(?:[.,]\\d{1,2})?)';
const REG_PATTERNS = [
  new RegExp('førpris(?:\\s*fra)?\\s*:?\\s*(?:kr\\.?\\s*)?' + NUM, 'i'),
  new RegExp('ord(?:\\.|inær)\\s*pris\\s*:?\\s*(?:kr\\.?\\s*)?' + NUM, 'i'),
  new RegExp('normalpris\\s*:?\\s*(?:kr\\.?\\s*)?' + NUM, 'i'),
];

function parseRegularFromText(text) {
  for (const re of REG_PATTERNS) {
    const m = re.exec(text || '');
    if (m) return parseFloat(m[1].replace(',', '.'));
  }
  return null;
}

// Package-level regular price for the same quantity the offer price buys.
function offerRegular(offer) {
  const price = offer.pricing && offer.pricing.price;
  const pre = offer.pricing && offer.pricing.pre_price;
  if (pre > 0 && pre >= price) return { price: pre, source: 'Førpris in flyer' };
  // Text prices on multi-buy offers usually refer to one unit; only trust single-piece offers.
  const pieces = (offer.quantity && offer.quantity.pieces && offer.quantity.pieces.from) || 1;
  if (pieces <= 1) {
    const parsed = parseRegularFromText(offer.description);
    if (parsed && parsed >= price && parsed < price * 5) return { price: parsed, source: 'Førpris in description' };
  }
  return null;
}

// ---- Kassalapp regular prices ------------------------------------------

// Regular shelf price = the most common price over the last `days` days (ties -> higher).
// A short campaign shows up as a minority price and is ignored.
function regularFromHistory(product, now, days = 90) {
  const cutoff = now - days * 864e5;
  const counts = new Map();
  for (const h of product.price_history || []) {
    const t = Date.parse(h.date);
    if (!(h.price > 0) || (t && t < cutoff)) continue;
    counts.set(h.price, (counts.get(h.price) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [price, n] of counts) {
    if (n > bestN || (n === bestN && price > best)) { best = price; bestN = n; }
  }
  if (best == null && product.current_price > 0) best = product.current_price;
  return best;
}

function productStoreName(p) {
  const s = Array.isArray(p.store) ? p.store[0] : p.store;
  return s && s.name;
}

// ---- matching ---------------------------------------------------------

// Matching is per word. A term word matches a word that starts with it
// ("kylling" -> "kyllingfilet"). A leading * matches a word that ends with it,
// which is how Norwegian compounds work ("*smør" -> "meierismør", "*egg" -> "gårdsegg").
// Plain substrings are too loose: "egg" would hit "sleggeburger" and "skjeggerød".
//
// Matching is accent-insensitive: users often type without æøå ("kjottdeig"),
// so ø→o, æ→ae, å→a (and other diacritics are stripped) on both sides.
function fold(s) {
  return norm(s).replace(/ø/g, 'o').replace(/æ/g, 'ae').normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
}
const words = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const tokensOf = (s) => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function wordMatches(tw, toks) {
  if (tw.startsWith('*')) {
    const core = tw.replace(/^\*+/, '');
    return core.length > 0 && toks.some((t) => t.endsWith(core));
  }
  return toks.some((t) => t.startsWith(tw));
}

// A term matches when all its words appear in heading+extra and at least one is in the heading/name.
function termMatches(term, heading, extra) {
  const tws = fold(term).split(' ').filter((w) => w.replace(/\*/g, ''));
  if (!tws.length) return false;
  const h = words(heading), all = h.concat(words(extra));
  return tws.every((w) => wordMatches(w, all)) && tws.some((w) => wordMatches(w, h));
}

function itemMatches(item, heading, extra) {
  const h = fold(heading);
  if ((item.exclude || []).some((x) => fold(x) && h.includes(fold(x)))) return false;
  const terms = item.terms && item.terms.length ? item.terms : [item.name];
  return terms.some((t) => termMatches(t, heading, extra));
}

// Kassalapp's search is spelling-exact and has no wildcards. Rewrite each term
// with the spelling actually used in matching flyer headings ("kjottdeig" ->
// "kjøttdeig"), and drop the '*'. Words not seen in any heading are kept as typed.
function searchTerms(item, offers) {
  const terms = item.terms && item.terms.length ? item.terms : [item.name];
  return terms.map((term) => fold(term).split(' ').filter(Boolean).map((tw) => {
    const suffix = tw.startsWith('*');
    const core = tw.replace(/^\*+/, '');
    for (const o of offers) {
      for (const tok of tokensOf(o.heading)) {
        const ft = fold(tok);
        if (suffix ? !ft.endsWith(core) : !ft.startsWith(core)) continue;
        // Shortest slice of the original word that folds to the typed word.
        for (let i = 1; i <= tok.length; i++) {
          const part = suffix ? tok.slice(tok.length - i) : tok.slice(0, i);
          if (fold(part) === core) return part;
        }
      }
    }
    return core;
  }).join(' ')).filter((t) => t.length >= 3);
}

function tokens(s) { return new Set(norm(s).split(/[^a-zæøå0-9]+/).filter((w) => w.length > 1)); }
function overlap(a, b) { let n = 0; for (const w of a) if (b.has(w)) n++; return n; }

// ---- main --------------------------------------------------------------

const DIM_LABEL = { kg: 'kg', l: 'l', stk: 'stk', pk: 'pk' };

/**
 * @param {object} p
 * @param {object[]} p.offers        Tjek offers (already limited to this week)
 * @param {object[]} p.trackedItems  [{id, name, terms[], exclude[]}]
 * @param {string[]} p.shopKeys      shopKey()s of the shops the user shops at
 * @param {object}   p.kassal        { [trackedItemId]: KassalappProduct[] }
 * @param {boolean}  p.kassalEnabled whether a Kassalapp key is configured (only changes messages)
 * @param {number}   p.now
 */
function compute({ offers, trackedItems, shopKeys, kassal = {}, kassalEnabled = false, now = Date.now() }) {
  const allowed = new Set(shopKeys);
  const shops = new Map();      // shopKey -> { name, logo, color, items: Map(offerId -> entry) }
  const dropped = [];
  const summary = [];

  for (const item of trackedItems) {
    const cands = offers
      .filter((o) => allowed.has(shopKey(o.dealer.name)) && itemMatches(item, o.heading, o.description))
      .map((o) => {
        const { dim, amount } = offerAmount(o);
        const reg = offerRegular(o);
        return {
          offer: o, dim, amount, shop: shopKey(o.dealer.name), shopName: o.dealer.name,
          unitPrice: o.pricing.price / amount,
          reg, regUnit: reg ? reg.price / amount : null,
        };
      });

    // Regular prices from Kassalapp, restricted to the user's shops.
    const kprods = relevantProducts(item, kassal[item.id] || [])
      .map((p) => {
        const a = productAmount(p);
        const name = productStoreName(p);
        const reg = regularFromHistory(p, now);
        if (!a || !name || !(reg > 0)) return null;
        return { product: p, dim: a.dim, amount: a.amount, shop: shopKey(name), shopName: name, regular: reg, regUnit: reg / a.amount };
      })
      .filter((k) => k && allowed.has(k.shop));

    const sum = { id: item.id, name: item.name, candidates: cands.length, shown: 0 };
    summary.push(sum);
    if (!cands.length) continue;

    const byDim = new Map();
    for (const c of cands) (byDim.get(c.dim) || byDim.set(c.dim, []).get(c.dim)).push(c);

    for (const [dim, group] of byDim) {
      const unit = DIM_LABEL[dim];
      const min = Math.min(...group.map((c) => c.unitPrice));
      const winners = group.filter((c) => c.unitPrice <= min * (1 + 1e-9));
      const best = winners[0];

      for (const c of group) {
        if (winners.includes(c)) continue;
        dropped.push(drop(item, c, `Cheaper at ${best.shopName}: ${kr(best.unitPrice)}/${unit} vs ${kr(c.unitPrice)}/${unit}`));
      }

      // Every known regular price in this group, per shop: from flyers and from Kassalapp.
      const regulars = [
        ...group.filter((c) => c.regUnit).map((c) => ({ shop: c.shop, shopName: c.shopName, regUnit: c.regUnit, label: c.offer.heading, source: c.reg.source })),
        ...kprods.filter((k) => k.dim === dim).map((k) => ({ shop: k.shop, shopName: k.shopName, regUnit: k.regUnit, label: k.product.name, source: 'Kassalapp' })),
      ];

      for (const w of winners) {
        const others = regulars.filter((r) => r.shop !== w.shop).sort((a, b) => a.regUnit - b.regUnit);
        const cheaperElsewhere = others[0] && others[0].regUnit < w.unitPrice - 1e-9 ? others[0] : null;
        if (cheaperElsewhere) {
          dropped.push(drop(item, w, `Regular price at ${cheaperElsewhere.shopName} is lower: ${kr(cheaperElsewhere.regUnit)}/${unit} (${cheaperElsewhere.label}) vs ${kr(w.unitPrice)}/${unit} on offer`));
          continue;
        }

        const ref = referencePrice(w, kprods, others);
        if (!ref) {
          dropped.push(drop(item, w, 'No reference regular price found' + (kassalEnabled ? '' : '. A Kassalapp key in Settings adds shelf prices.')));
          continue;
        }
        if (ref.price <= w.offer.pricing.price) {
          dropped.push(drop(item, w, `Not below regular price (${kr(ref.price)}, ${ref.source})`));
          continue;
        }

        sum.shown++;
        addToShop(shops, w, item, unit, ref);
      }
    }
  }

  const shopList = [...shops.values()]
    .map((s) => ({ ...s, items: [...s.items.values()].sort((a, b) => a.trackedItems[0].localeCompare(b.trackedItems[0], 'nb')) }))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name, 'nb'));
  return { shops: shopList, dropped, summary };
}

// Kassalapp names include whole dishes ("Grandiosa Pizza Kjøttdeig&Løk"), so a
// name match alone would let a pizza count as "cheaper kjøttdeig elsewhere".
// If any result sits in a category named like the item (e.g. "Kjøttdeig"),
// keep only products in such categories; otherwise fall back to name matching.
function relevantProducts(item, products) {
  const named = products.filter((p) => itemMatches(item, p.name, p.brand));
  const inCategory = (p) => (p.categories || []).some((c) => itemMatches(item, c, ''));
  return named.some(inCategory) ? named.filter(inCategory) : named;
}

// Order: price printed in the flyer -> same shop's shelf price from Kassalapp ->
// cheapest regular price at another shop for the same amount.
function referencePrice(w, kprods, others) {
  if (w.reg) return { price: w.reg.price, unitPrice: w.reg.price / w.amount, source: w.reg.source };

  const heading = tokens(w.offer.heading + ' ' + (w.offer.description || '').split('\n')[0]);
  const same = kprods
    .filter((k) => k.shop === w.shop && k.dim === w.dim)
    .map((k) => ({ k, sizeDiff: Math.abs(k.amount - w.amount) / w.amount, score: overlap(heading, tokens(k.product.name + ' ' + (k.product.brand || ''))) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => (a.sizeDiff <= 0.1 ? 0 : 1) - (b.sizeDiff <= 0.1 ? 0 : 1) || b.score - a.score || a.sizeDiff - b.sizeDiff);
  if (same.length) {
    const { k } = same[0];
    const price = k.regUnit * w.amount;
    return { price, unitPrice: k.regUnit, source: `Kassalapp shelf price (${k.product.name})` };
  }

  if (others.length) {
    const o = others[0];
    return { price: o.regUnit * w.amount, unitPrice: o.regUnit, source: `Cheapest regular elsewhere: ${o.shopName} (${o.label})` };
  }
  return null;
}

function addToShop(shops, w, item, unit, ref) {
  const o = w.offer;
  let shop = shops.get(w.shop);
  if (!shop) {
    shop = { key: w.shop, name: o.dealer.name, logo: o.dealer.logo, color: o.dealer.color, items: new Map() };
    shops.set(w.shop, shop);
  }
  const existing = shop.items.get(o.id);
  if (existing) {
    if (!existing.trackedItems.includes(item.name)) existing.trackedItems.push(item.name);
    return;
  }
  shop.items.set(o.id, {
    id: o.id,
    url: o.url || null,
    heading: o.heading,
    description: o.description,
    image: o.images && o.images.thumb,
    price: o.pricing.price,
    unitPrice: w.unitPrice,
    unit,
    regular: ref,
    savingsPct: Math.round((1 - o.pricing.price / ref.price) * 100),
    runFrom: o.run_from,
    runTill: o.run_till,
    trackedItems: [item.name],
  });
}

// Display shape of any offer (browse results, dropped offers), matching what a
// shown deal has. `regular` is only the offer's own flyer regular price and may
// be null: these offers have not been through the reference-price lookup.
function describeOffer(o) {
  const { dim, amount } = offerAmount(o);
  const reg = offerRegular(o);
  return {
    id: o.id,
    url: o.url || null,
    shop: o.dealer.name,
    logo: o.dealer.logo,
    heading: o.heading,
    description: o.description,
    image: o.images && o.images.thumb,
    price: o.pricing.price,
    unitPrice: o.pricing.price / amount,
    unit: DIM_LABEL[dim],
    regular: reg ? { price: reg.price, unitPrice: reg.price / amount, source: reg.source } : null,
    runFrom: o.run_from,
    runTill: o.run_till,
  };
}

function drop(item, c, reason) {
  return { ...describeOffer(c.offer), tracked: item.name, reason };
}

function kr(n) { return n.toFixed(2).replace('.', ','); }

// Offers that are valid at some point between now and the end of this week:
// Sunday 23:59:59 Oslo time.
function endOfWeek(now) {
  const parts = (t) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Oslo', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'shortOffset',
  }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts(now).weekday);
  const sun = parts(now + ((7 - wd) % 7) * 864e5);
  const off = (sun.timeZoneName.match(/GMT([+-]\d+)/) || [, '+1'])[1];
  const sign = off.startsWith('-') ? '-' : '+';
  const hh = String(Math.abs(parseInt(off, 10))).padStart(2, '0');
  return Date.parse(`${sun.year}-${sun.month}-${sun.day}T23:59:59${sign}${hh}:00`);
}
// Oslo wall-clock time -> epoch ms (DST-aware). Day overflow is fine (Date.UTC normalises).
function osloToUtc(y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h);
  const off = (t) => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Oslo', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName').value;
    return parseInt((name.match(/GMT([+-]\d+)/) || [, '0'])[1], 10);
  };
  const first = guess - off(guess) * 3600e3;
  return guess - off(first) * 3600e3;
}

/**
 * Weekly fetch schedule. Flyers change on Sunday and run from Monday, so offers
 * are fetched once a week at `weekday` (0=Sun, 1=Mon) `hour`:00 Oslo time.
 * Returns the most recent slot at or before `now`, and the next one.
 */
function fetchSlots(now, weekday = 1, hour = 1) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Oslo', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const y = +p.year, m = +p.month;
  let d = +p.day - ((wd - weekday + 7) % 7);
  if (osloToUtc(y, m, d, hour) > now) d -= 7;
  return { last: osloToUtc(y, m, d, hour), next: osloToUtc(y, m, d + 7, hour) };
}

function isThisWeek(offer, now) {
  const from = Date.parse(offer.run_from), till = Date.parse(offer.run_till);
  return till >= now && from <= endOfWeek(now);
}

module.exports = {
  compute, shopKey, norm, fold, searchTerms, describeOffer, offerAmount, offerRegular, parseRegularFromText,
  regularFromHistory, itemMatches, termMatches, isThisWeek, endOfWeek, fetchSlots,
};
