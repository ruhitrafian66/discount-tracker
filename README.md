# Tilbud Tracker

LAN-only web app that shows this week's grocery discounts in Norway, grouped by shop, for the items you track.

Runs on a small home server behind nginx. It's meant for your local network only and has no login.

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
server.js          HTTP server, JSON-file storage, refresh scheduler, API
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

Environment variables: `HOST` (default 127.0.0.1), `PORT` (default 3003), `DATA_DIR` (default ./data), and `FETCH_WEEKDAY` / `FETCH_HOUR` for the weekly fetch time (default 1 / 1 = Monday 01:00 Oslo), and `DISABLE_FETCH=1` to skip all calls to the external APIs (used in CI).

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
