#!/usr/bin/env bash
# Ship the monitor sources to the observatory VM, build them there, install the
# systemd units, and (re)start everything. Idempotent — safe to re-run to deploy
# a new build.
#
# Usage: HOST=observatory@<ip> ./deploy.sh
#   env: HOST (required)  SSH_KEY (default ~/.ssh/xrpl-labs)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
: "${HOST:?set HOST=observatory@<ip>}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/xrpl-labs}"
SSH=(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$HOST")
RSYNC_RSH="ssh -i $SSH_KEY -o IdentitiesOnly=yes"

WEBHOOK="$(grep -E '^MATTERMOST_WEBHOOK_URL=' "$REPO/.env" | cut -d= -f2- | tr -d '"' || true)"
[ -n "$WEBHOOK" ] || { echo "MATTERMOST_WEBHOOK_URL not found in $REPO/.env"; exit 1; }

echo "==> syncing monitor sources to $HOST"
"${SSH[@]}" 'sudo install -d -o observatory -g observatory /opt/observatory/src'
rsync -az --delete -e "$RSYNC_RSH" \
  --exclude target --exclude .git \
  "$REPO/monitors/" "$HOST:/opt/observatory/src/"

echo "==> building release binaries on the VM"
"${SSH[@]}" 'bash -lc "cd /opt/observatory/src && ~/.cargo/bin/cargo build --release -j2 -p vlwatch -p xrpl-crawler"'

echo "==> installing binaries + config"
"${SSH[@]}" 'sudo install -d /opt/observatory/bin && \
  sudo install /opt/observatory/src/target/release/vlwatch /opt/observatory/bin/ && \
  sudo install /opt/observatory/src/target/release/xrpl-crawler /opt/observatory/bin/ && \
  sudo install -m0644 /opt/observatory/src/crawler/mainnet-unl.txt /opt/observatory/mainnet-unl.txt'

echo "==> installing publishers.txt + heartbeat.sh"
rsync -az -e "$RSYNC_RSH" "$HERE/publishers.txt" "$HOST:/tmp/publishers.txt"
rsync -az -e "$RSYNC_RSH" "$HERE/heartbeat.sh" "$HOST:/tmp/heartbeat.sh"
"${SSH[@]}" 'sudo install -m0644 /tmp/publishers.txt /opt/observatory/publishers.txt && \
  sudo install -m0755 /tmp/heartbeat.sh /opt/observatory/heartbeat.sh'

echo "==> writing /etc/observatory.env"
"${SSH[@]}" "printf 'MATTERMOST_WEBHOOK_URL=%s\nOBSERVATORY_STATE_BUCKET=xrplf-release-notifier\n' '$WEBHOOK' | sudo tee /etc/observatory.env >/dev/null && sudo chmod 600 /etc/observatory.env"

echo "==> installing systemd units"
rsync -az -e "$RSYNC_RSH" "$HERE/systemd/" "$HOST:/tmp/observatory-units/"
"${SSH[@]}" 'sudo cp /tmp/observatory-units/*.service /tmp/observatory-units/*.timer /etc/systemd/system/ && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable --now vlwatch.service crawler-monitor.service crawler-crawl.timer observatory-heartbeat.timer && \
  sudo systemctl restart vlwatch.service crawler-monitor.service'

echo "==> status"
"${SSH[@]}" 'systemctl --no-pager --lines=0 status vlwatch.service crawler-monitor.service crawler-crawl.timer observatory-heartbeat.timer | grep -E "●|Active:"'
echo "deploy complete."
