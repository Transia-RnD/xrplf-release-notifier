#!/usr/bin/env bash
# Ship the monitor sources to the observatory VM, build them there, install the
# systemd units, and (re)start everything. Idempotent — safe to re-run to deploy
# a new build.
#
# Usage: HOST=observatory@<ip> ./deploy.sh
#   env: HOST (required)  SSH_KEY (default ~/.ssh/xrpl-labs)
#        SILENT (default 1) — 1: monitors run in --dry-run (log would-be alerts to
#               the journal, post NOTHING). 0: post live to Mattermost.
#        GCS_SA_KEY (optional path to a GCP SA key JSON; only needed for the
#               heartbeat on a non-GCP host — on GCP the VM SA covers it)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
: "${HOST:?set HOST=observatory@<ip>}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/xrpl-labs}"
SSH=(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$HOST")
RSYNC_RSH="ssh -i $SSH_KEY -o IdentitiesOnly=yes"

WEBHOOK="$(grep -E '^MATTERMOST_WEBHOOK_URL=' "$REPO/.env" | cut -d= -f2- | tr -d '"' || true)"
[ -n "$WEBHOOK" ] || { echo "MATTERMOST_WEBHOOK_URL not found in $REPO/.env"; exit 1; }

echo "==> ensuring toolchain on $HOST (rustup, build deps, gcloud)"
"${SSH[@]}" 'set -e
  sudo install -d -o observatory -g observatory /opt/observatory /var/lib/observatory
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  sudo apt-get install -y -qq build-essential pkg-config perl make git rsync curl
  # gcloud (for the heartbeat) is not in the base apt repos — use snap, best-effort.
  command -v gcloud >/dev/null || sudo snap install google-cloud-cli --classic || echo "WARN: gcloud not installed — heartbeat will be skipped"
  sudo -u observatory bash -lc "command -v cargo >/dev/null || (curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y)"'

# Optional GCS credential for the heartbeat (required off-GCP).
if [ -n "${GCS_SA_KEY:-}" ]; then
  echo "==> installing GCS SA key for heartbeat"
  rsync -az -e "$RSYNC_RSH" "$GCS_SA_KEY" "$HOST:/tmp/observatory-sa.json"
  "${SSH[@]}" 'sudo install -m0600 -o observatory -g observatory /tmp/observatory-sa.json /etc/observatory-sa.json && rm -f /tmp/observatory-sa.json'
fi

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
# Silent by default: monitors evaluate rules and log would-be alerts to the
# journal but post nothing. SILENT=0 switches them to live posting.
if [ "${SILENT:-1}" = "0" ]; then
  MONITOR_FLAGS="--webhook $WEBHOOK"
  echo "    posting: LIVE"
else
  MONITOR_FLAGS="--dry-run"
  echo "    posting: SILENT (--dry-run; nothing posts to Mattermost)"
fi
GCREDS=""
[ -n "${GCS_SA_KEY:-}" ] && GCREDS='GOOGLE_APPLICATION_CREDENTIALS=/etc/observatory-sa.json\n'
"${SSH[@]}" "printf 'MONITOR_FLAGS=%s\nOBSERVATORY_STATE_BUCKET=xrplf-release-notifier\n${GCREDS}' '$MONITOR_FLAGS' | sudo tee /etc/observatory.env >/dev/null && sudo chmod 600 /etc/observatory.env"

echo "==> installing systemd units"
rsync -az -e "$RSYNC_RSH" "$HERE/systemd/" "$HOST:/tmp/observatory-units/"
"${SSH[@]}" 'sudo cp /tmp/observatory-units/*.service /tmp/observatory-units/*.timer /etc/systemd/system/ && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable --now vlwatch.service crawler-monitor.service crawler-crawl.timer crawler-amendments.timer crawler-nunl.timer observatory-heartbeat.timer && \
  sudo systemctl restart vlwatch.service crawler-monitor.service'

echo "==> status"
"${SSH[@]}" 'systemctl --no-pager --lines=0 status vlwatch.service crawler-monitor.service crawler-crawl.timer crawler-amendments.timer crawler-nunl.timer observatory-heartbeat.timer | grep -E "●|Active:"'
echo "deploy complete."
