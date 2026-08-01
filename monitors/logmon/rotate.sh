#!/usr/bin/env bash
# rotate.sh — size-based rotation + gzip for an xrpld trace log, using the node's
# native `log_rotate` admin RPC (close-and-reopen). Run from cron or `watch`.
#
#   1. if debug.log >= LOGMON_MAX_BYTES:
#   2.   mv debug.log  archive/debug-<ts>.log   (node keeps writing via its fd)
#   3.   POST {"method":"log_rotate"} to the admin RPC  (node reopens a fresh debug.log)
#   4.   gzip the archived file
#   5.   prune *.gz older than LOGMON_RETAIN_DAYS
#
# This mirrors the logrotate(8) pattern but uses the in-process RPC instead of a
# signal, since xrpld has no SIGHUP handler (see src/xrpld/rpc/handlers/admin/log/).
set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=logmon.env
source ./logmon.env

mkdir -p "$LOGMON_ARCHIVE"

[ -f "$LOGMON_LOG" ] || { echo "rotate: no log at $LOGMON_LOG"; exit 0; }

# Portable byte size (avoids macOS/Linux `stat` flag differences).
size=$(wc -c < "$LOGMON_LOG" | tr -d ' ')
if [ "$size" -lt "$LOGMON_MAX_BYTES" ]; then
  exit 0
fi

ts=$(date -u +%Y%m%dT%H%M%SZ)
archived="$LOGMON_ARCHIVE/debug-$ts.log"

mv "$LOGMON_LOG" "$archived"

# Tell the node to close the (now-renamed) fd and reopen the original path.
# The admin RPC method is `logrotate` (no underscore) — see Handler.cpp.
resp=$(curl -fsS "$LOGMON_ADMIN_RPC" \
  -H 'Content-Type: application/json' \
  -d '{"method":"logrotate","params":[{}]}' || true)
echo "rotate: logrotate -> ${resp:-<no response>}"

gzip -f "$archived"
echo "rotate: archived $(basename "$archived").gz"

if [ "${LOGMON_RETAIN_DAYS:-0}" -gt 0 ]; then
  find "$LOGMON_ARCHIVE" -name 'debug-*.log.gz' -type f \
    -mtime +"$LOGMON_RETAIN_DAYS" -delete
fi
