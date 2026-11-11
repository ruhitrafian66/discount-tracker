#!/usr/bin/env bash
# One-time server setup, run from your workstation:
#
#   ./deploy/setup-server.sh <ssh-host> <server-name> [repo-url]
#   e.g. ./deploy/setup-server.sh myserver tilbud.local
#
# The server needs node (>= 20), git, curl and nginx, and root over SSH.
# It clones the repo to /opt/discount-tracker, creates /etc/discount-tracker/env
# from env.example (if missing), installs the app and deploy units and an nginx
# vhost, and starts the 1-minute pull-deploy timer. After this, every push to main
# that passes CI is deployed automatically. Safe to re-run.
set -euo pipefail
SSH_HOST="${1:?usage: setup-server.sh <ssh-host> <server-name> [repo-url]}"
SERVER_NAME="${2:?usage: setup-server.sh <ssh-host> <server-name> [repo-url]}"
REPO_URL="${3:-$(git -C "$(dirname "$0")/.." remote get-url origin)}"
case "$REPO_URL" in git@github.com:*) REPO_URL="https://github.com/${REPO_URL#git@github.com:}" ;; esac

ssh "$SSH_HOST" SERVER_NAME="$SERVER_NAME" REPO_URL="$REPO_URL" bash -s <<'EOF'
set -euo pipefail
APP=/opt/discount-tracker

if [[ ! -d $APP/.git ]]; then
  [[ -e $APP ]] && mv "$APP" "$APP.pre-git.$(date +%Y%m%d%H%M%S)"
  git clone --quiet "$REPO_URL" "$APP"
fi
chown -R root:root "$APP"

install -d -m 755 /etc/discount-tracker
[[ -f /etc/discount-tracker/env ]] || install -m 644 "$APP/deploy/env.example" /etc/discount-tracker/env
source /etc/discount-tracker/env

install -m 644 "$APP/deploy/discount-tracker.service" /etc/systemd/system/
install -m 644 "$APP/deploy/discount-tracker-deploy.service" /etc/systemd/system/
install -m 644 "$APP/deploy/discount-tracker-deploy.timer" /etc/systemd/system/
install -m 755 "$APP/deploy/pull-deploy.sh" /usr/local/sbin/discount-tracker-deploy

sed -e "s/__SERVER_NAME__/$SERVER_NAME/" -e "s/__PORT__/$PORT/" \
  "$APP/deploy/nginx.conf.template" > /etc/nginx/sites-available/discount-tracker
ln -sf /etc/nginx/sites-available/discount-tracker /etc/nginx/sites-enabled/discount-tracker

# Optional: publish SERVER_NAME over mDNS if the host has an avahi-alias@ template unit.
if [[ $SERVER_NAME == *.local ]] && systemctl cat avahi-alias@.service >/dev/null 2>&1; then
  systemctl enable --now "avahi-alias@$SERVER_NAME.service"
fi

systemctl daemon-reload
systemctl enable discount-tracker.service discount-tracker-deploy.timer
systemctl restart discount-tracker.service
systemctl start discount-tracker-deploy.timer
nginx -t && systemctl reload nginx
sleep 2
systemctl --no-pager --lines=3 status discount-tracker.service
systemctl --no-pager list-timers discount-tracker-deploy.timer
EOF
