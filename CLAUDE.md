# CLAUDE.md

Tilbud Tracker: a LAN-only web app showing this week's Norwegian grocery discounts, grouped by shop, filtered to the user's tracked items. Self-hosted on a home server. See README.md for user-facing behaviour. Machine-specific details (SSH alias, host layout) are in the untracked `CLAUDE.local.md`. Never commit them: the repo is public.

## Commands

```sh
node --test test/*.test.js                 # engine rules, fetcher, server.js over HTTP
DATA_DIR=/tmp/dt PORT=3913 node server.js  # run locally; keep DATA_DIR out of the repo
git push origin main                       # deploys: CI passes -> server pulls within ~1 min
```

`node --test test/` (a directory) fails on Node 24; pass the glob.

## Constraints

- **No npm dependencies, no build step.** The Pi runs Node 20, so use only Node 20 built-ins (global `fetch`, `node:test`). `node:sqlite` is not available there; storage is atomic JSON files in `DATA_DIR`.
- **Settings change only through `updateSettings()`** in `server.js`: it builds a new object from the current one, writes it, then swaps it in, one change at a time. A failed write leaves memory as it was. `save()` writes each file through its own temp file, one write at a time per file; it does not call `touch()`. An unparseable `settings.json` is moved aside at start (`settings.json.unreadable-<time>`) instead of being overwritten by the defaults.
- `lib/engine.js` is pure (no I/O). All business rules live there and are tested in `test/engine.test.js`. Change a rule there, with a test, not in `server.js`.
- Offer text comes from external APIs. In `public/app.js`, always pass it through `esc()` before putting it in `innerHTML`. Links go through `safeUrl()` (https only).
- Write endpoints require `Content-Type: application/json` and a same-origin `Origin` (CSRF guard; the app has no auth). Keep that for any new mutating route.
- Never return the Kassalapp key to the client; the API only exposes `kassalKeySet`.
- One popup shows every offer: `showOffer()` in `public/app.js`, used by Deals, Dropped offers and Browse. Offers that are not shown deals get their display shape from `engine.describeOffer()` (dropped entries and `/api/offers`). Add a field in both places, not per list.

## Performance (the server is a small ARM board, ~20x slower than a laptop)

Opening the app must stay fast; `/api/state` once took 2.7 s there. Rules that keep it at a few ms:

- `server.js` caches the week's offers and the serialised state (`cached()`, keyed on `rev`). Anything that changes what the view shows must call `touch()`, or the old view keeps being served; write a file only when its content changed. The cache also expires after 5 minutes because "this week" depends on the clock.
- Never construct `Intl.DateTimeFormat` per offer or per request; use `osloParts()` in the engine. Pass a precomputed `end` to `isThisWeek()` when filtering.
- `fold()`, `words()` and `termWords()` are memoised per string, and `compileItem()` per item object. Tracked items are replaced, never edited in place, so that cache stays valid; keep it that way. Do not mutate arrays returned by `words()`.
- The page paints the last state it saw from `localStorage` (`SEEN` in `public/app.js`) before the fresh one arrives. Bump the number in `SEEN` when the shape of `/api/state` changes, so an old copy is not rendered.
- Static files and `/api/state` send ETags; nginx gzips JS, CSS and JSON (in `deploy/nginx.conf.template`, applied by `setup-server.sh`, not by the pull deploy).

## The user's rules (do not weaken)

1. Show only tracked items (match terms / exclude words).
2. Per tracked item, show only the cheapest offer by unit price (kg / l / stk; `pk` when the pack size is unknown). Compare only within the same unit.
3. Drop an offer if another selected shop's *regular* unit price is lower than its discount price.
4. Every shown item must have a reference regular price, in this order: flyer `pre_price` → "Førpris/Ord. pris" parsed from the description (single-piece offers only) → Kassalapp shelf price at the same chain → cheapest regular price elsewhere. If there is none, drop it.
5. Every drop is recorded with a human-readable reason (shown in the UI).

## Data sources (verified 2026-11-11)

- **Tjek squid API** `https://squid-api.tjek.com/v2` is the backend behind eTilbudsavis.no and Mattilbud.no. No key. It ignores `country_id`, so scope by `r_lat`/`r_lng`/`r_radius`. Hard cap of 1000 results per query (`PAGINATION_MAX_REACHED`), so fetch per `dealer_ids`. Grocery dealer IDs are in `lib/tjek.js`.
  - `price` covers `quantity.size × quantity.pieces.from` (e.g. 40 × 0.33 l). Sizes can be ranges (averaged); a `to` below `from` (`{from: 400, to: 1}`) is not a range, and `from` is the size.
  - Packs are often encoded as `unit: pcs, size: 1`; the real count ("18 PK", "80 stk") is parsed from the text and multiplied by `pieces`, unless both are the same number (the same count given twice).
  - Offers are validated when fetched (`tjek.valid`): the cache is kept for a week, so one without a heading or a positive price never enters it.
  - `pre_price` is present on only ~30% of grocery offers.
  - Public offer page: `https://etilbudsavis.no/{slug}?publication={catalog_id}&offer={id}`. The slug must be the dealer's real `markets[].slug` ("REMA-1000", "Naerbutikken"); a guessed slug is a 404, and mattilbud.no has no equivalent URL. `tjek.offerUrl()` builds it at fetch time and stores it on the slim offer.
- **Kassalapp** `https://kassal.app/api/v1` is optional (Bearer key, set in Settings), ~60 req/min. `/products?search=` (min 3 chars, size ≤ 100). The regular price is the most common price in `price_history` over 90 days. Most of what a search returns is unusable and is not cached (`engine.usableProduct`): in November 2026, 494 of 812 products had no price sample in 90 days (some none for years) and 404 had no weight. A `piece` weight that contradicts the count in the product name is not trusted. Live data covers Meny, SPAR, Joker and Bunnpris; every KIWI and Coop product was stale, there is no REMA 1000, and all Coop chains share one store named "Coop" (`COOP_NO`), which `shopKey()` matches to none of them.

## Fetch schedule

Offers are fetched once per week (`engine.fetchSlots`, default Monday 01:00 Oslo time; `FETCH_WEEKDAY`/`FETCH_HOUR`) and cached all week. This is a user requirement: keep API load minimal, with no manual refresh button or TTL-based refetching. The 15-minute timer is only a local staleness check. `refreshAll()` runs one refresh at a time; a request arriving during one (a new item, a changed location) gets its own pass as soon as it ends. The only off-schedule API calls are for a changed location, a newly selected shop, a failed shop (retried at most hourly), and Kassalapp lookups for new or edited items. Changing what `tjek.slim()` stores needs a bump of `OFFERS_CACHE_V` in `server.js`, which rebuilds the cache once; do that only when a feature needs new fields.

## Matching semantics

Matching is accent-insensitive via `fold()` (ø→o, æ→ae, å→a). Kassalapp searches use the spelling seen in flyer headings (`searchTerms`), because Kassalapp search is spelling-exact. Kassalapp products are filtered by category when one matches the item (`relevantProducts`); otherwise dishes like "Grandiosa Pizza Kjøttdeig" pass as cheaper regular prices.

A term is cut into words the way offer text is, at anything that is not a letter or digit (`coca-cola` = `coca cola`, `14%` = `14`). A term word matches words that *start with* it; a leading `*` matches words that *end with* it (Norwegian compounds: `*smør` → meierismør). Plain substring matching was tried and rejected ("egg" hit "pålegg", "truseinnlegg"). All words of a term must appear, at least one in the title. Exclude words are a substring match on the title. Browse search uses the same `termMatches`, in `engine.browse()`, which also counts the matches per shop for the shop filter on that page (`/api/offers?q=&shops=id,id`).

## Deployment

Pull-based CD (see README.md): `.github/workflows/ci.yml` runs on GitHub, and the server's `discount-tracker-deploy.timer` runs `deploy/pull-deploy.sh` every minute. That script deploys `origin/main` only once all check runs for the commit succeeded, then runs the tests, restarts, health-checks `/api/state` and rolls back on failure. Notes:

- To deploy, push to main. There is no push-based deploy script, and the server must never need inbound access or GitHub secrets.
- `pull-deploy.sh` reinstalls itself and the units from the repo on each deploy, so changes to them ship like code. Keep its body inside `main()`: bash reads scripts lazily, and the file is replaced while running.
- Host-specific values belong in `/etc/discount-tracker/env` on the server (template: `deploy/env.example`), not in tracked files. nginx config is rendered from `deploy/nginx.conf.template`.
- The server is small and its disk is nearly full, so keep caches slim (`tjek.slim()`, `kassal` slim) and avoid adding dependencies.

## Public repo hygiene

Do not commit IPs, hostnames/SSH aliases, other services on the server, keys, or personal emails. Commits use the GitHub noreply address (set in this repo's local git config).

## Known bugs (audit 2026-11-16)

Delete an entry in the commit that fixes it. Counts come from one week of live Oslo data (637 offers, 812 cached Kassalapp products).

- **B15** `public/app.js`: every re-render re-opens collapsed shop cards.
- **B16** `deploy/pull-deploy.sh`: a commit with no check runs (`[skip ci]`) reads as pending forever, so the server polls the GitHub API every minute. Found by reading.

Stale docs: the server's disk is no longer nearly full. Node 20 on the Pi passed end-of-life on 2026-04-30.
