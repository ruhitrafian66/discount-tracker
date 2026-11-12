# CLAUDE.md

**Branches:** `main` is the Pi build (LAN, no auth, one shared settings file); the Pi's pull-deployer follows it. `netlify` (this branch) is the Netlify build where each browser keeps its own list via a cookie (no login); Netlify's production branch is `netlify`. Don't merge `netlify` into `main`. Fixes to shared code (`lib/engine.js`, `lib/tjek.js`, `lib/kassal.js`, the UI) go to `main` first, then get merged into `netlify`.

Tilbud Tracker: a web app showing this week's Norwegian grocery discounts, grouped by shop, filtered to each user's tracked items. Runs self-hosted on a home server (LAN, `server.js`) and on Netlify (`netlify/`), from the same core (`lib/app.js`). See README.md for user-facing behaviour. Machine-specific details (SSH alias, host layout) are in the untracked `CLAUDE.local.md`. Never commit them: the repo is public.

## Commands

```sh
node --test test/*.test.js                 # unit tests (engine rules)
DATA_DIR=/tmp/dt PORT=3913 node server.js  # run locally; keep DATA_DIR out of the repo
git push origin main                       # deploys: CI passes -> server pulls within ~1 min
```

`node --test test/` (a directory) fails on Node 24; pass the glob.

## Constraints

- **No npm dependencies, no build step**, with one exception: `@netlify/blobs`, imported only by `netlify/*.mjs` (Netlify installs it). `server.js`, `lib/` and tests must never require it; the Pi has no `node_modules`. The Pi runs Node 20, so use only Node 20 built-ins (global `fetch`, `Request`/`Response`, `node:test`); Netlify functions run Node 22.
- **Storage goes through `lib/store.js`** (`get/set/del/list` of JSON documents): files in `DATA_DIR` on the Pi, Blobs on Netlify, in-memory in tests. Documents are replaced, never edited in place. `lib/app.js` is host-neutral (`Request -> Response`); keep host specifics in `server.js` / `netlify/`.
- **Lists per browser, no accounts:** a random ID in an HttpOnly cookie (`tt_visitor`), set on the first save; items live in `visitors/<sha256 of ID>`, so the store never holds the cookie value. Shops are per visitor too (`PUT /api/shops`; default = `settings.shops`); every grocery chain plus `flags.wantedShops` (other chains someone picked, rebuilt weekly) is fetched. Only the location is shared, and changing it needs `ADMIN_CODE` (locked if unset). The Kassalapp key is `KASSAL_KEY` only: no route sets it, and the UI has no Kassalapp field. Don't create a visitor document or cookie on reads.
- `lib/engine.js` is pure (no I/O). All business rules live there and are tested in `test/engine.test.js`. Change a rule there, with a test, not in `server.js`.
- Offer text comes from external APIs. In `public/app.js`, always pass it through `esc()` before putting it in `innerHTML`. Links go through `safeUrl()` (https only).
- Write endpoints require `Content-Type: application/json` and a same-origin `Origin` (CSRF guard on top of `SameSite=Lax`). Keep that for any new mutating route.
- Never return the Kassalapp key to the client; the API only exposes `kassalKeySet`.
- One popup shows every offer: `showOffer()` in `public/app.js`, used by Deals, Dropped offers and Browse. Offers that are not shown deals get their display shape from `engine.describeOffer()` (dropped entries and `/api/offers`). Add a field in both places, not per list.

## Performance (the server is a small ARM board, ~20x slower than a laptop)

Opening the app must stay fast; `/api/state` once took 2.7 s there. Rules that keep it at a few ms:

- `lib/app.js` caches the week's offers (keyed on `rev`) and each user's serialised state (keyed on `rev` + the user's `rev`). Shared data must change through `saveGlobal()` and user data through `saveUser()`, or the old view keeps being served. The caches also expire after 5 minutes because "this week" depends on the clock. On the Pi the file store keeps every document in memory; on Netlify shared data is re-read after `globalTtlMs` (60 s).
- Never construct `Intl.DateTimeFormat` per offer or per request; use `osloParts()` in the engine. Pass a precomputed `end` to `isThisWeek()` when filtering.
- `fold()`, `words()` and `termWords()` are memoised per string, and `compileItem()` and the Kassalapp `termsKeyFor()` per item object. Tracked items are replaced, never edited in place, so that cache stays valid; keep it that way. Do not mutate arrays returned by `words()`.
- Static files and `/api/state` send ETags; nginx gzips JS, CSS and JSON (in `deploy/nginx.conf.template`, applied by `setup-server.sh`, not by the pull deploy).

## The user's rules (do not weaken)

1. Show only tracked items (match terms / exclude words).
2. Per tracked item, show only the cheapest offer by unit price (kg / l / stk; `pk` when the pack size is unknown). Compare only within the same unit.
3. Drop an offer if another selected shop's *regular* unit price is lower than its discount price.
4. Every shown item must have a reference regular price, in this order: flyer `pre_price` → "Førpris/Ord. pris" parsed from the description (single-piece offers only) → Kassalapp shelf price at the same chain → cheapest regular price elsewhere. If there is none, drop it.
5. Every drop is recorded with a human-readable reason (shown in the UI).

## Data sources (verified 2026-11-11)

- **Tjek squid API** `https://squid-api.tjek.com/v2` is the backend behind eTilbudsavis.no and Mattilbud.no. No key. It ignores `country_id`, so scope by `r_lat`/`r_lng`/`r_radius`. Hard cap of 1000 results per query (`PAGINATION_MAX_REACHED`), so fetch per `dealer_ids`. Grocery dealer IDs are in `lib/tjek.js`.
  - `price` covers `quantity.size × quantity.pieces.from` (e.g. 40 × 0.33 l). Sizes can be ranges (averaged).
  - Packs are often encoded as `unit: pcs, size: 1`; the real count ("18 PK", "80 stk") is parsed from the text.
  - `pre_price` is present on only ~30% of grocery offers.
  - Public offer page: `https://etilbudsavis.no/{slug}?publication={catalog_id}&offer={id}`. The slug must be the dealer's real `markets[].slug` ("REMA-1000", "Naerbutikken"); a guessed slug is a 404, and mattilbud.no has no equivalent URL. `tjek.offerUrl()` builds it at fetch time and stores it on the slim offer.
- **Kassalapp** `https://kassal.app/api/v1` is optional (Bearer key, set in Settings), ~60 req/min. `/products?search=` (min 3 chars, size ≤ 100). The regular price is the most common price in `price_history` over 90 days. Chain names differ from Tjek's ("Coop Extra" vs "Extra"); `shopKey()` normalises them.

## Fetch schedule

Offers are fetched once per week (`engine.fetchSlots`, default Monday 01:00 Oslo time; `FETCH_WEEKDAY`/`FETCH_HOUR`) and cached all week. This is a user requirement: keep API load minimal, with no manual refresh button or TTL-based refetching. The 15-minute timer (Pi: `setInterval`; Netlify: the `refresh` scheduled function) is only a local staleness check calling `work()`. `work({ budgetMs })` stops starting API calls after the budget (Netlify functions are time-limited) and the next run resumes, because each shop's fetch time is stored separately. The Kassalapp cache is keyed by search-term set, shared across users; `flags.kassalDirtyAt` marks a new or edited item. The only off-schedule API calls are for a changed location, a newly selected shop, a failed shop (retried at most hourly), and Kassalapp lookups for new or edited items. Changing what `tjek.slim()` stores needs a bump of `OFFERS_CACHE_V` in `lib/app.js`, which rebuilds the cache once; do that only when a feature needs new fields.

## Matching semantics

Matching is accent-insensitive via `fold()` (ø→o, æ→ae, å→a). Kassalapp searches use the spelling seen in flyer headings (`searchTerms`), because Kassalapp search is spelling-exact. Kassalapp products are filtered by category when one matches the item (`relevantProducts`); otherwise dishes like "Grandiosa Pizza Kjøttdeig" pass as cheaper regular prices.

A term word matches words that *start with* it; a leading `*` matches words that *end with* it (Norwegian compounds: `*smør` → meierismør). Plain substring matching was tried and rejected ("egg" hit "pålegg", "truseinnlegg"). All words of a term must appear, at least one in the title. Exclude words are a substring match on the title. Browse search uses the same `termMatches`.

## Deployment

Pull-based CD (see README.md): `.github/workflows/ci.yml` runs on GitHub, and the server's `discount-tracker-deploy.timer` runs `deploy/pull-deploy.sh` every minute. That script deploys `origin/main` only once all check runs for the commit succeeded, then runs the tests, restarts, health-checks `/api/state` and rolls back on failure. Notes:

- Netlify deploys from the same push (Netlify's Git integration, `netlify.toml`); its secrets (`ADMIN_CODE`, `KASSAL_KEY`) live in Netlify's environment variables, never in the repo.
- To deploy, push to main. There is no push-based deploy script, and the server must never need inbound access or GitHub secrets.
- `pull-deploy.sh` reinstalls itself and the units from the repo on each deploy, so changes to them ship like code. Keep its body inside `main()`: bash reads scripts lazily, and the file is replaced while running.
- Host-specific values belong in `/etc/discount-tracker/env` on the server (template: `deploy/env.example`), not in tracked files. nginx config is rendered from `deploy/nginx.conf.template`.
- The server is small and its disk is nearly full, so keep caches slim (`tjek.slim()`, `kassal` slim) and avoid adding dependencies.

## Public repo hygiene

Do not commit IPs, hostnames/SSH aliases, other services on the server, keys, or personal emails. Commits use the GitHub noreply address (set in this repo's local git config).
