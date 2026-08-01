#!/usr/bin/env bash
# run.sh — live ingest: follow the node's debug.log and stream parsed JSONL.
#
# `tail -F` handles file rotation/reopen robustly (it reopens by path when the
# inode changes), so the Rust binary stays a pure stdin parser. New hourly JSONL
# files appear under $LOGMON_JSONL as the node logs.
#
#   ./run.sh            # follow live, write hourly JSONL
#   ./run.sh --once     # parse the current debug.log once and exit (no follow)
set -euo pipefail

cd "$(dirname "$0")"
# shellcheck source=logmon.env
source ./logmon.env

BIN="./target/release/logmon"
[ -x "$BIN" ] || { echo "run: build first -> cargo build --release"; exit 1; }
mkdir -p "$LOGMON_JSONL"

if [ "${1:-}" = "--once" ]; then
  exec "$BIN" --out "$LOGMON_JSONL" --host "$LOGMON_HOST" "$LOGMON_LOG"
fi

echo "run: following $LOGMON_LOG -> $LOGMON_JSONL (host=$LOGMON_HOST)"
exec tail -n +1 -F "$LOGMON_LOG" \
  | "$BIN" --out "$LOGMON_JSONL" --host "$LOGMON_HOST" --source debug.log -
