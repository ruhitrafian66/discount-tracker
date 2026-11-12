# Tilbud Tracker

Web app that shows this week's grocery discounts in Norway, grouped by shop, for the items you track.

**This is the `netlify` branch**: the Netlify deployment. Each browser keeps its own list (cookie, no login). The `main` branch is the LAN build for the home server (no login, one shared list) and is what the server deploys. `server.js` still works here for local development; see [Netlify](#netlify) for deploying.

## Your list (cookie, no login)

There are no accounts. The first time you save a tracked item, the site sets an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over https) with a random ID. Your list is stored on the server under a hash of that ID, so the same browser gets the same list back. A different browser or device, or clearing cookies, starts with an empty list. The cookie lasts 400 days, the most browsers allow, and every save renews it. Lists not saved for longer than that are deleted.

Your shops are yours too: tick the chains you shop at under **Settings → Your shops**. Only those are compared, for discounts and for "another shop's regular price is cheaper", and the choice is saved for this browser. Every grocery chain is fetched once a week anyway. Picking one of the "other chains" adds it to the weekly fetch, and it's fetched once right away.

The location is shared by everyone on the site. Changing it needs the admin code (`ADMIN_CODE`), typed in under Settings. Without `ADMIN_CODE` it is locked.

There is no Kassalapp setting in the app. The key can only be set as the `KASSAL_KEY` environment variable on Netlify, so visitors can neither see nor change it.

## Rules

For each tracked item, the app collects matching offers from your selected shops. It compares them by unit price (kr/kg, kr/l or kr/stk, or kr/pk when the pack size is unknown):

1. **Cheapest only.** Only the offer with the lowest unit price is shown. If several shops tie (for example a chain-wide Coop offer), each of them shows it.
2. **Regular price elsewhere.** The offer is dropped if any *other* selected shop's regular unit price is lower than this discount.
3. **Reference regular price.** Every shown item has one. The first available source is used:
   1. førpris printed in the flyer,
   2. "Førpris / Ord. pris …" parsed from the offer text (single-piece offers only),
   3. the same chain's shelf price from Kassalapp (only if an API key is set),
   4. the cheapest regular price at another shop for the same amount.

   If none of these exists, the offer is dropped.

Every dropped offer is listed under **Dropped offers** with its reason.

The Deals page groups deals by shop, with the shop where you save the most kroner first, and lists each deal as a compact row. Tapping one opens a popup with the image, flyer text, the regular price and where it comes from, and a **View in flyer** link to the offer on eTilbudsavis. Dropped offers and Browse results open the same popup: a dropped offer shows why it was left out, and a browse result has a **+ Track** button.

## Match terms

- `kylling` matches words that *start with* it (kyllingfilet).
- `*smør` matches words that *end with* it (meierismør, the usual Norwegian compound).
- `tine *smør`: every word must appear, and at least one of them in the offer title.
- Exclude words drop an offer if they appear anywhere in its title.
- Spelling of æ/ø/å doesn't matter: `kjottdeig` matches KJØTTDEIG.

Use **Browse offers** to try terms out. It uses the same matching rules.

## Data sources

- **Tjek squid API** (`squid-api.tjek.com/v2`): the backend behind eTilbudsavis.no and Mattilbud.no. Public, location-based, at most 1000 results per query, so offers are fetched per shop. Flyers change on Sunday and run from Monday, so offers are fetched **once a week, Monday 01:00 Oslo time**, and kept for the rest of the week. There is no manual refresh. If the server was down at that time, it catches up once on start. Changing the location or adding a shop fetches only what's missing.
- **Kassalapp** (`kassal.app/api/v1`): optional, needs a free API key (Settings). Supplies per-chain shelf prices. The regular price is the most common price in the last 90 days, so a short campaign doesn't count as the regular price. Looked up weekly with the offers, and right away for new or edited items. When an item's name matches a Kassalapp category (e.g. "Kjøttdeig"), only products in such categories count. That stops a pizza with kjøttdeig in its name from being treated as cheaper kjøttdeig.

## Layout

```
lib/app.js         API, per-browser lists, offer + Kassalapp refresh (host-neutral: Request -> Response)
lib/store.js       storage interface; JSON files (Pi) and in-memory (tests)
server.js          Pi entry point: static files, adapter to lib/app.js, 15-minute refresh timer
netlify/           Netlify entry points (functions/api.mjs, functions/refresh.mjs) and the Blobs store
lib/engine.js      pure comparison rules (unit-tested)
lib/tjek.js        offer fetcher; list of grocery dealer ids
lib/kassal.js      Kassalapp client
public/            UI (no build step)
deploy/            systemd units, nginx template, setup + pull-deploy scripts
.github/workflows/ CI
test/              node --test
```

## Develop

```sh
node --test test/*.test.js
DATA_DIR=./data PORT=3913 node server.js     # http://localhost:3913
```

Environment variables: `HOST` (default 127.0.0.1), `PORT` (default 3003), `DATA_DIR` (default ./data), and `FETCH_WEEKDAY` / `FETCH_HOUR` for the weekly fetch time (default 1 / 1 = Monday 01:00 Oslo), `DISABLE_FETCH=1` to skip all calls to the external APIs (used in CI), `ADMIN_CODE` for changing the shared settings and `KASSAL_KEY` (see [Your list](#your-list-cookie-no-login)).

## Deployment (pull-based CD)

```
push to main ──► GitHub Actions: tests, smoke test, shellcheck
                       │
server timer (every minute) ── git fetch ──► new commit and CI passed?
                       └─► checkout ─► tests ─► restart ─► health check ─► roll back on failure
```

The server pulls; GitHub never connects to it. So the server needs no inbound access, holds no GitHub credentials, and runs no self-hosted runner (GitHub advises against self-hosted runners on public repos).

One-time setup, from your workstation (root over SSH; the server needs node ≥ 20, git, curl and nginx):

```sh
./deploy/setup-server.sh <ssh-host> <server-name>     # e.g. ./deploy/setup-server.sh myserver tilbud.local
```

This clones the repo to `/opt/discount-tracker` and creates `/etc/discount-tracker/env` from [deploy/env.example](deploy/env.example). That env file holds host-specific settings and is never committed. The script also installs the `discount-tracker` service, the `discount-tracker-deploy.timer` deployer and an nginx vhost. After that, every push to `main` that passes CI is live within about a minute.

On the server:

```sh
journalctl -u discount-tracker-deploy -n 20   # deploy log
journalctl -u discount-tracker -n 50          # app log
systemctl start discount-tracker-deploy       # deploy now instead of waiting
```

A commit whose CI or deploy fails is recorded in `/var/lib/discount-tracker-deploy/failed` and skipped. The next good commit deploys normally.

## Netlify

`netlify.toml` serves `public/` as static files. `netlify/functions/api.mjs` handles `/api/*`, and Netlify Blobs replaces the JSON files. `netlify/functions/refresh.mjs` is a scheduled function that runs every 15 minutes. It does the same staleness check as the Pi's timer, so the external APIs are still only called once a week, plus the off-schedule cases. There is no build step. Netlify installs the one dependency, `@netlify/blobs`, which only the functions use.

One-time setup:

1. In Netlify: **Add new site → Import an existing project**, then pick this GitHub repo. The build settings come from `netlify.toml`.
2. Before the first deploy, under **Site configuration → Environment variables**, set:
   - `ADMIN_CODE`: a code for changing the shared location (without it, it's locked),
   - optionally `KASSAL_KEY`, and `FETCH_WEEKDAY` / `FETCH_HOUR`.
3. Deploy, open the site, then set location and shops under Settings with the admin code.

After that, every push to `main` deploys to Netlify as well as to the Pi.

Differences from the Pi:

- Netlify stops a scheduled function after 30 seconds, so the weekly fetch may be split over a few 15-minute runs. Monday's first offers can take up to about an hour to complete.
- Changing the location or shops, or adding an item, starts the fetch or Kassalapp lookup right away, within the request's time limit. Whatever doesn't finish, the next scheduled run picks up.
- Shared data is cached in each function instance for one minute.
- The admin-code throttle (10 wrong codes per 15 minutes) is counted per function instance.

Local check without Netlify: `node --test test/*.test.js` covers the core with an in-memory store. `npx netlify dev` runs the functions with a local Blobs emulator.
