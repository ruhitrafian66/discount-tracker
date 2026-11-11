#!/usr/bin/env bash
# Pull-based continuous deployment, run on the server by discount-tracker-deploy.timer.
#
# Each run: fetch the deploy branch from GitHub. If it moved, wait for GitHub
# Actions to pass on that commit, check it out, run the tests, restart the
# service and health-check it. Roll back to the previous commit on any failure.
#
# Pull-based on purpose: the server needs no inbound access, no stored GitHub
# credentials, and no self-hosted runner (unsafe on a public repo).
set -euo pipefail

main() {
  local APP_DIR=/opt/discount-tracker
  local STATE=/var/lib/discount-tracker-deploy
  # shellcheck disable=SC1091
  source /etc/discount-tracker/env
  local BRANCH="${DEPLOY_BRANCH:-main}"
  mkdir -p "$STATE"

  exec 9>"$STATE/lock"
  flock -n 9 || exit 0

  cd "$APP_DIR"
  git fetch --quiet origin "$BRANCH"
  local cur new
  cur=$(git rev-parse HEAD)
  new=$(git rev-parse "origin/$BRANCH")
  [[ "$cur" == "$new" ]] && exit 0
  if grep -qx "$new" "$STATE/failed" 2>/dev/null; then exit 0; fi

  local short=${new:0:7}
  case "$(ci_status "$new")" in
    success) ;;
    pending) echo "$short: waiting for CI"; exit 0 ;;
    *) echo "$short: CI did not pass; not deploying"; echo "$new" >>"$STATE/failed"; exit 0 ;;
  esac

  echo "$short: deploying (was ${cur:0:7})"
  git reset --quiet --hard "$new"
  if deploy_current; then
    echo "$short: deployed"
  else
    echo "$short: deploy failed; rolling back to ${cur:0:7}"
    echo "$new" >>"$STATE/failed"
    git reset --quiet --hard "$cur"
    deploy_current || echo "rollback to ${cur:0:7} also failed"
    exit 1
  fi
}

# Test, (re)install systemd units if they changed, restart, health-check.
deploy_current() {
  node --test test/*.test.js >/dev/null || { echo "tests failed"; return 1; }
  local changed=0
  install_if_changed deploy/discount-tracker.service /etc/systemd/system/discount-tracker.service && changed=1
  install_if_changed deploy/discount-tracker-deploy.service /etc/systemd/system/discount-tracker-deploy.service && changed=1
  install_if_changed deploy/discount-tracker-deploy.timer /etc/systemd/system/discount-tracker-deploy.timer && changed=1
  # Atomic replace: this running script keeps reading its old inode.
  install_if_changed deploy/pull-deploy.sh /usr/local/sbin/discount-tracker-deploy 755 || true
  ((changed)) && systemctl daemon-reload
  systemctl restart discount-tracker
  local _
  for _ in $(seq 1 20); do
    sleep 1
    curl -fsS -m 3 -o /dev/null "http://127.0.0.1:${PORT}/api/state" && return 0
  done
  echo "health check failed"
  return 1
}

# install_if_changed SRC DEST [MODE] -> returns 0 if DEST was updated.
install_if_changed() {
  cmp -s "$1" "$2" 2>/dev/null && return 1
  install -m "${3:-644}" "$1" "$2.new" && mv -f "$2.new" "$2"
}

# Combined GitHub Actions check-run state for a commit: success | pending | failure.
# Public repo, so no token needed; this is only called when the branch moved.
ci_status() {
  local repo
  repo=$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')
  curl -fsS -m 15 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$repo/commits/$1/check-runs?per_page=100" 2>/dev/null |
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let runs;
      try { runs = JSON.parse(s).check_runs; } catch { return console.log("pending"); }
      if (!runs || !runs.length) return console.log("pending");
      if (runs.some((r) => r.status !== "completed")) return console.log("pending");
      const ok = runs.every((r) => ["success", "neutral", "skipped"].includes(r.conclusion));
      console.log(ok ? "success" : "failure");
    });' || echo pending
}

main "$@"
