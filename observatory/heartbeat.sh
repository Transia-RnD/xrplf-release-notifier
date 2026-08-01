#!/usr/bin/env bash
# Publish a heartbeat JSON (per-unit active state + timestamp) to GCS so the
# notifier watchdog can raise OBSERVATORY_STALE if the box or a monitor dies.
set -euo pipefail

BUCKET="${OBSERVATORY_STATE_BUCKET:-xrplf-release-notifier}"
UNITS=(vlwatch.service crawler-monitor.service crawler-crawl.timer)

status_json=""
for u in "${UNITS[@]}"; do
  state="$(systemctl is-active "$u" 2>/dev/null || true)"
  status_json+="\"${u}\":\"${state}\","
done
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
body="{\"ts\":\"${now}\",\"host\":\"$(hostname)\",\"units\":{${status_json%,}}}"

tmp="$(mktemp)"
printf '%s' "$body" >"$tmp"
gsutil -q cp "$tmp" "gs://${BUCKET}/observatory/heartbeat.json"
rm -f "$tmp"
echo "heartbeat published: $body"
