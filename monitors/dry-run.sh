#!/usr/bin/env bash
# Run the observatory monitors against the live network in DRY-RUN: rules are
# evaluated and would-be alerts are printed, nothing is posted to Mattermost.
#
# Usage: ./dry-run.sh [vlwatch|crawl|monitor|all] [seconds]
set -euo pipefail

cd "$(dirname "$0")"
WHAT="${1:-all}"
SECS="${2:-40}"
STATE_DIR="$(mktemp -d)"
BIN="target/release"

echo "building release binaries..."
cargo build --release -q -p vlwatch -p xrpl-crawler

run_vlwatch() {
  echo ""
  echo "=== vlwatch (${SECS}s, dry-run) ==="
  "$BIN/vlwatch" --dry-run --state-file "$STATE_DIR/vlwatch.json" --for "$SECS"
}

run_crawl() {
  echo ""
  echo "=== crawler crawl (dry-run) ==="
  local pid
  "$BIN/xrpl-crawler" crawl \
    --seeds r.ripple.com:51235 --concurrency 40 --timeout 5 \
    --output "$STATE_DIR/crawl-state.json" \
    --report-json "$STATE_DIR/crawl-report.json" \
    --dry-run &
  pid=$!
  sleep "$SECS"; kill -INT "$pid" 2>/dev/null || true
  sleep 3; kill -9 "$pid" 2>/dev/null || true
  echo "--- report ---"; cat "$STATE_DIR/crawl-report.json" 2>/dev/null || echo "(no report)"
}

run_monitor() {
  echo ""
  echo "=== crawler monitor (${SECS}s, dry-run) ==="
  local pid
  "$BIN/xrpl-crawler" monitor \
    --endpoints wss://s1.ripple.com \
    --state-file "$STATE_DIR/crawl-state.json" \
    --output "$STATE_DIR/validations.jsonl" \
    --alerts "$STATE_DIR/alerts.jsonl" \
    --dry-run &
  pid=$!
  sleep "$SECS"; kill -INT "$pid" 2>/dev/null || true
  sleep 2; kill -9 "$pid" 2>/dev/null || true
}

case "$WHAT" in
  vlwatch) run_vlwatch ;;
  crawl)   run_crawl ;;
  monitor) run_monitor ;;
  all)     run_vlwatch; run_crawl ;;
  *) echo "unknown: $WHAT (use vlwatch|crawl|monitor|all)"; exit 2 ;;
esac

echo ""
echo "dry-run complete. state in $STATE_DIR"
