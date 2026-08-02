#!/usr/bin/env python3
"""Manifest-flood DoS patch-adoption report from a crawler report-json.

Classifies crawled nodes by whether they run a build that contains the 3.2.1
manifest-flood hotfix (the Aug 2026 peer-protocol resource-exhaustion fix):

  patched      rippled/xrpld >= 3.2.1  (incl. 3.2.1 RCs and the 3.3.0 dev line)
  vulnerable   rippled/xrpld <  3.2.1  (3.2.0, 3.1.x, 2.x, ...)
  other        non-core clients (xrpl-rust, custom overlays) / unknown

Usage:
  attack-report.py REPORT_JSON --dry-run          # print the Mattermost payload
  attack-report.py REPORT_JSON --post [--webhook URL]   # post it
"""
import argparse
import json
import os
import re
import sys
import urllib.request

FIX = (3, 2, 1)  # first version with the manifest caps

# (major, minor, patch) of the fix, matched against the base semver of a build.
CORE = re.compile(r"^(?:rippled|xrpld)-(\d+)\.(\d+)\.(\d+)")


def classify(version: str):
    m = CORE.match(version)
    if not m:
        return "other"
    base = tuple(int(x) for x in m.groups())
    return "patched" if base >= FIX else "vulnerable"


def build(report: dict):
    versions = report.get("versions", {})
    buckets = {"patched": 0, "vulnerable": 0, "other": 0}
    vuln_detail = {}
    for ver, count in versions.items():
        klass = classify(ver)
        buckets[klass] += count
        if klass == "vulnerable":
            vuln_detail[ver] = count
    total = sum(buckets.values()) or 1
    core = buckets["patched"] + buckets["vulnerable"] or 1
    top_vuln = sorted(vuln_detail.items(), key=lambda x: -x[1])[:5]
    return buckets, total, core, top_vuln


def payload(report: dict):
    buckets, total, core, top_vuln = build(report)
    patched_pct = buckets["patched"] * 100 // core
    vuln_pct = buckets["vulnerable"] * 100 // core
    color = "#E53935" if vuln_pct >= 50 else "#FF9800"
    top = "\n".join(f"- `{v}` — {c}" for v, c in top_vuln)
    text = (
        f"Crawl of **{total}** reachable nodes. Of **{core}** core (rippled/xrpld) nodes, "
        f"**{patched_pct}%** run the 3.2.1+ manifest-flood hotfix; **{vuln_pct}%** are still on "
        f"pre-3.2.1 builds vulnerable to the untrusted-manifest cache DoS.\n\n"
        f"**Top vulnerable builds:**\n{top}"
    )
    return {
        "username": "xrpl network monitor",
        "attachments": [
            {
                "color": color,
                "title": ":rotating_light: Manifest-flood DoS — network patch adoption",
                "text": text,
                "fields": [
                    {"title": "patched (>=3.2.1)", "value": str(buckets["patched"]), "short": True},
                    # "pre-X" not "<X": Mattermost renders "<3" as a heart emoji
                    {"title": "vulnerable (pre-3.2.1)", "value": str(buckets["vulnerable"]), "short": True},
                    {"title": "other/non-core", "value": str(buckets["other"]), "short": True},
                    {"title": "total crawled", "value": str(total), "short": True},
                ],
                "footer": "xrpl-crawler",
            }
        ],
    }


def webhook_from_env():
    env = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    if os.path.exists(env):
        for line in open(env):
            if line.startswith("MATTERMOST_WEBHOOK_URL="):
                return line.split("=", 1)[1].strip().strip('"')
    return os.environ.get("MATTERMOST_WEBHOOK_URL")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("report")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--post", action="store_true")
    ap.add_argument("--webhook")
    args = ap.parse_args()

    report = json.load(open(args.report))
    body = payload(report)

    if args.post:
        url = args.webhook or webhook_from_env()
        if not url:
            print("no webhook (set MATTERMOST_WEBHOOK_URL or --webhook)", file=sys.stderr)
            sys.exit(1)
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                # The Mattermost host sits behind a WAF that 403s the default
                # Python-urllib user-agent; send a descriptive one.
                "User-Agent": "xrplf-release-notifier/monitors",
            },
        )
        with urllib.request.urlopen(req) as resp:
            print(f"posted: HTTP {resp.status}")
    else:
        print(json.dumps(body, indent=2))


if __name__ == "__main__":
    main()
