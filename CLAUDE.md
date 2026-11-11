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
- Offer text comes from external APIs. In `public/app.js`, always pass it through `esc()` before putting it in `innerHTML`.
- Write endpoints require `Content-Type: application/json` and a same-origin `Origin` (CSRF guard; the app has no auth). Keep that for any new mutating route.
- Never return the Kassalapp key to the client; the API only exposes `kassalKeySet`.

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
- **Kassalapp** `https://kassal.app/api/v1` is optional (Bearer key, set in Settings), ~60 req/min. `/products?search=` (min 3 chars, size ≤ 100). The regular price is the most common price in `price_history` over 90 days. Chain names differ from Tjek's ("Coop Extra" vs "Extra"); `shopKey()` normalises them.

## Matching semantics

A term word matches words that *start with* it; a leading `*` matches words that *end with* it (Norwegian compounds: `*smør` → meierismør). Plain substring matching was tried and rejected ("egg" hit "pålegg", "truseinnlegg"). All words of a term must appear, at least one in the title. Exclude words are a substring match on the title. Browse search uses the same `termMatches`.

## Deployment

Pull-based CD (see README.md): `.github/workflows/ci.yml` runs on GitHub, and the server's `discount-tracker-deploy.timer` runs `deploy/pull-deploy.sh` every minute. That script deploys `origin/main` only once all check runs for the commit succeeded, then runs the tests, restarts, health-checks `/api/state` and rolls back on failure. Notes:

- To deploy, push to main. There is no push-based deploy script, and the server must never need inbound access or GitHub secrets.
- `pull-deploy.sh` reinstalls itself and the units from the repo on each deploy, so changes to them ship like code. Keep its body inside `main()`: bash reads scripts lazily, and the file is replaced while running.
- Host-specific values belong in `/etc/discount-tracker/env` on the server (template: `deploy/env.example`), not in tracked files. nginx config is rendered from `deploy/nginx.conf.template`.
- The server is small and its disk is nearly full, so keep caches slim (`tjek.slim()`, `kassal` slim) and avoid adding dependencies.

## Public repo hygiene

Do not commit IPs, hostnames/SSH aliases, other services on the server, keys, or personal emails. Commits use the GitHub noreply address (set in this repo's local git config).
