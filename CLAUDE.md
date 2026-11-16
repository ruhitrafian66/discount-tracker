# CLAUDE.md

Tilbud Tracker: a LAN-only web app showing this week's Norwegian grocery discounts, grouped by shop, filtered to the user's tracked items. Self-hosted on a home server. See README.md for user-facing behaviour. Machine-specific details (SSH alias, host layout) are in the untracked `CLAUDE.local.md`. Never commit them: the repo is public.

## Commands

```sh
node --test test/*.test.js                 # unit tests (engine rules)
DATA_DIR=/tmp/dt PORT=3913 node server.js  # run locally; keep DATA_DIR out of the repo
git push origin main                       # deploys: CI passes -> server pulls within ~1 min
```

`node --test test/` (a directory) fails on Node 24; pass the glob.

## Constraints

- **No npm dependencies, no build step.** The Pi runs Node 20, so use only Node 20 built-ins (global `fetch`, `node:test`). `node:sqlite` is not available there; storage is atomic JSON files in `DATA_DIR`.
- `lib/engine.js` is pure (no I/O). All business rules live there and are tested in `test/engine.test.js`. Change a rule there, with a test, not in `server.js`.
- Offer text comes from external APIs. In `public/app.js`, always pass it through `esc()` before putting it in `innerHTML`. Links go through `safeUrl()` (https only).
- Write endpoints require `Content-Type: application/json` and a same-origin `Origin` (CSRF guard; the app has no auth). Keep that for any new mutating route.
- Never return the Kassalapp key to the client; the API only exposes `kassalKeySet`.
- One popup shows every offer: `showOffer()` in `public/app.js`, used by Deals, Dropped offers and Browse. Offers that are not shown deals get their display shape from `engine.describeOffer()` (dropped entries and `/api/offers`). Add a field in both places, not per list.

## Performance (the server is a small ARM board, ~20x slower than a laptop)

Opening the app must stay fast; `/api/state` once took 2.7 s there. Rules that keep it at a few ms:

- `server.js` caches the week's offers and the serialised state (`cached()`, keyed on `rev`). Anything that changes what the view shows must end in `save()` or call `touch()`, or the old view keeps being served. The cache also expires after 5 minutes because "this week" depends on the clock.
- Never construct `Intl.DateTimeFormat` per offer or per request; use `osloParts()` in the engine. Pass a precomputed `end` to `isThisWeek()` when filtering.
- `fold()`, `words()` and `termWords()` are memoised per string, and `compileItem()` per item object. Tracked items are replaced, never edited in place, so that cache stays valid; keep it that way. Do not mutate arrays returned by `words()`.
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

Offers are fetched once per week (`engine.fetchSlots`, default Monday 01:00 Oslo time; `FETCH_WEEKDAY`/`FETCH_HOUR`) and cached all week. This is a user requirement: keep API load minimal, with no manual refresh button or TTL-based refetching. The 15-minute timer is only a local staleness check. The only off-schedule API calls are for a changed location, a newly selected shop, a failed shop (retried at most hourly), and Kassalapp lookups for new or edited items. Changing what `tjek.slim()` stores needs a bump of `OFFERS_CACHE_V` in `server.js`, which rebuilds the cache once; do that only when a feature needs new fields.

## Matching semantics

Matching is accent-insensitive via `fold()` (ø→o, æ→ae, å→a). Kassalapp searches use the spelling seen in flyer headings (`searchTerms`), because Kassalapp search is spelling-exact. Kassalapp products are filtered by category when one matches the item (`relevantProducts`); otherwise dishes like "Grandiosa Pizza Kjøttdeig" pass as cheaper regular prices.

A term word matches words that *start with* it; a leading `*` matches words that *end with* it (Norwegian compounds: `*smør` → meierismør). Plain substring matching was tried and rejected ("egg" hit "pålegg", "truseinnlegg"). All words of a term must appear, at least one in the title. Exclude words are a substring match on the title. Browse search uses the same `termMatches`.

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

Wrong results:

- **B1** `engine.regularFromHistory`: a Kassalapp price of any age counts as today's shelf price (it falls back to `current_price` when every sample is older than 90 days). 494 of 812 products had no sample in 90 days, including every Coop and KIWI one. Two real deals were dropped against prices 9 months and 4 years old.
- **B2** `engine.termWords`: term words split on spaces only, offer text on every non-letter, so a term with punctuation (`coca-cola`, `14%`, `a/b`) matches nothing. "+ Track" in Browse copies the heading as the term: for 126 of 637 offers the new item misses its own offer. `startTracking()` in `public/app.js` also lets a comma in the heading become separate OR-terms.
- **B4** `engine.offerAmount`: `size.to < size.from` (Tjek sends `{from: 400, to: 1}`) is averaged to 200.5 g, doubling the unit price. 3 offers.
- **B5** `engine.productAmount`: Kassalapp `weight_unit: piece` is trusted when the name disagrees ("…Kaffeputer 18stk" with `weight: 126` gives 0,40 kr/stk), causing a false "regular price elsewhere is lower" drop.
- **B6** `engine.offerAmount`: the count in the text is multiplied by `pieces` even when both hold the same number ("10 stk" with `pieces: 10` gives 100 stk). Multiplying is right when they differ (2 × "14 stk").
- **B10** `engine.endOfWeek`: it adds whole 24 h days, so in the week before the spring DST change it returns Monday night between 23:00 and 24:00, and is 1 h off after midnight in both DST weeks.

Robustness:

- **B7** `server.js` `save()` on `main`: (a) one shared `.tmp` name, so concurrent saves fail with ENOENT (15 of 40 parallel adds returned 500 although the items were added); (b) memory changes before the write, so a failed write (disk full on 2026-11-15) leaves memory ahead of disk; (c) an unreadable `settings.json` silently becomes the defaults at start.
- **B8** `engine.compute` / `lib/tjek.js`: an offer with a missing or non-numeric `pricing.price` that matches a tracked item makes `compute()` throw (`best` is undefined), so `/api/state` answers 500 until the next weekly fetch; `price: null` counts as 0 kr and wins. None in the live data.
- **B9** A refresh requested while one is running is dropped (the `status.*` guards in `server.js` on `main`), so a location change or new item waits for the next 15-minute tick. Found by reading, not reproduced.
- **B11** `server.js` `readJson` on `main`: `Origin: null` makes `new URL` throw, giving a 500 and a stack trace in the log instead of a 403.
- **B12** `server.js` `refreshKassal()` on `main` rewrites `kassal.json` and bumps `rev` every 15 minutes when nothing changed (seen on the Pi).
- **B15** `public/app.js`: every re-render re-opens collapsed shop cards; Browse responses can arrive out of order and are not refreshed after the shops change.
- **B16** `deploy/pull-deploy.sh`: a commit with no check runs (`[skip ci]`) reads as pending forever, so the server polls the GitHub API every minute. Found by reading.

Stale docs: Kassalapp's Coop store is named "Coop" (code `COOP_NO`), which `shopKey()` matches to none of the Coop chains, unlike what "Data sources" says. The server's disk is no longer nearly full. Node 20 on the Pi passed end-of-life on 2026-04-30.
