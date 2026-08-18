#!/usr/bin/env bash
# Publish a heartbeat JSON (per-unit active state, root-disk use, timestamp) to
# GCS so the notifier watchdog can raise OBSERVATORY_STALE if the box or a
# monitor dies, or DISK_LOW before a full disk breaks the monitors silently.
set -euo pipefail

BUCKET="${OBSERVATORY_STATE_BUCKET:-xrplf-release-notifier}"
UNITS=(vlwatch.service crawler-monitor.service crawler-crawl.timer crawler-amendments.timer crawler-nunl.timer crawler-unl-adoption.timer)

status_json=""
for u in "${UNITS[@]}"; do
  state="$(systemctl is-active "$u" 2>/dev/null || true)"
  status_json+="\"${u}\":\"${state}\","
done
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Root-disk use as a whole percent. A full disk stops every atomic state write,
# which breaks alert dedup without stopping any unit — so units alone can't see it.
disk_pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
body="{\"ts\":\"${now}\",\"host\":\"$(hostname)\",\"disk_pct\":${disk_pct:-0},\"units\":{${status_json%,}}}"

tmp="$(mktemp)"
printf '%s' "$body" >"$tmp"
gsutil -q cp "$tmp" "gs://${BUCKET}/observatory/heartbeat.json"
rm -f "$tmp"
echo "heartbeat published: $body"
