# xrplf-release-notifier

Automated release notifications for rippled version changes. Monitors both [XRPLF/rippled](https://github.com/XRPLF/rippled) (public) and [XRPLF/xrpld-private](https://github.com/XRPLF/xrpld-private) (private), plus the official binary package repository (repos.ripple.com), and broadcasts release updates to Mattermost and Twitter/X.

## How It Works

A single rippled release fires through several upstream events (tag push, GitHub Release published, binary publish) and may fire **twice** — once from `XRPLF/rippled` (public) and once from `XRPLF/xrpld-private` (private).

Two channels, very different rules:

- **Mattermost** posts on **every** supported event. Duplicate signals are preferable to silent misses when maintainer workflow varies. Internal channel, signal-rich.
- **Twitter** posts **once per FINAL release**, only when the `.deb`/`.rpm` lands on `pool/stable/` (the "install now" moment). Tag pushes, RC release publishes, anything from xrpld-private — none of them tweet. The tweet includes the version-stamped release card PNG (`assets/release-card-template.svg` → 1200×675 PNG via `@resvg/resvg-js`) plus a `Release notes:` link. Posting is additionally gated behind `TWITTER_POSTING_ENABLED=true` — **currently off** while the AI-generated copy isn't accurate enough to publish unreviewed.

See the [delivery matrix](#delivery-matrix) for the full rules.

The service fails hard if AI summarization breaks — no fallback copy ever reaches a public channel.

**Webhook path:** GitHub webhooks installed on both repos deliver `push` and `release` events to `/webhook`:
- `push` to `refs/tags/X.Y.Z[-bN|-rcN]` → tag notification (BETA / RC / FINAL all post)
- `push` to any branch → ignored
- `release` with `action: published`, not draft → release notification (uses the release body)

**Polling path:** Cloud Scheduler triggers `/poll` every 15 minutes. The service scrapes `pool/stable/` on repos.ripple.com for new `.deb`/`.rpm` packages, fires both Mattermost and Twitter when a new FINAL binary appears. RC/beta builds live on `pool/unstable/` which is not polled. **This is the only place Twitter is invoked** — the tweet waits for the install-ready signal.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.template .env
# Fill in your secrets
```

### 3. Run locally

```bash
npm run serve
```

### 4. Test with a sample webhook

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$(echo -n '{}' | openssl dgst -sha256 -hmac 'your-secret' | cut -d' ' -f2)" \
  -d '{}'
```

## Testing

```bash
npm test
```

## Dry-run (iterating on copy)

To see exactly what would be posted to Mattermost and Twitter for a given rippled tag — without sending anything to either — run:

```bash
npm run build
npx ts-node scripts/dry-run.ts            # latest beta tag
npx ts-node scripts/dry-run.ts 3.1.3      # specific tag (final → release + binary)
npx ts-node scripts/dry-run.ts 3.2.0-b6   # beta tag (tag push only)
```

The script renders only the scenarios that would actually post for the given version type:
- BETA → tag push scenario only
- RC → release-published scenario only
- FINAL → release-published + binary-poll scenarios

`ANTHROPIC_API_KEY` is required (the script fails fast if it's missing — matches production behavior).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the iteration loop and which files to edit for prompt / copy changes.

## SDK feature-parity check

When rippled cuts a release, each XRPL SDK under XRPLF (xrpl.js, xrpl-py, xrpl4j, xrpl-rust) must add typed support for the new protocol features. This module checks whether they have — and posts a parity report to the same Mattermost channel. It's triggered off the existing public release events (no separate service).

**The key idea: a `definitions.json` diff is not enough.** A wire-name appearing in an SDK's `definitions.json` only proves the feature can be *serialized* — not that the SDK has a typed model, validation, and registry wiring for it. (xrpl-rust's `definitions.json` declares MPToken/Credential/Vault while having zero typed models for them — a definitions diff would falsely call it "at parity".) So the check is **two levels**:

- **Level 1 — serialization:** wire-name present in the SDK's bundled `definitions.json`.
- **Level 2 — typed support (the real gap):** a typed model exists **and** is wired into the SDK's central registry. Verdict per feature: `supported` / `declared-only` / `missing`, plus an in-progress-PR annotation.

**How it works:**
- `config/sdks.yaml` lists the target repos (just `repo` + `ref` — nothing path-shaped).
- `src/parity/reference.ts` parses rippled's tagged protocol macros (`features` / `transactions` / `ledger_entries` / `sfields`) to compute the features **new in this release** vs the predecessor — the checklist.
- A per-SDK agent runs the repo-agnostic skill in [config/parity-skill.md](config/parity-skill.md) over read-only GitHub tools (`listDir` / `readFile` / `grepFile` / `searchCode` / `listPRs` / `prFiles`). The skill carries the methodology, not file paths, so an SDK refactor never needs a config edit — the agent re-discovers locations and the result is cached (`parity-locations.json` in GCS, keyed by commit SHA). See [config/sdk-architecture.md](config/sdk-architecture.md) for a human snapshot of each SDK's structure.
- `src/parity/report.ts` posts the report: beta/RC → ⚠️ heads-up; FINAL with any SDK behind → 🔴.

The scan runs an agent per SDK and far outlives GitHub's 10s webhook window, so the webhook dispatches it (fire-and-forget) to an internal `/parity` worker endpoint. Needs `GITHUB_TOKEN` (anonymous GitHub is 60 req/hr) and `ANTHROPIC_API_KEY`.

**Dry-run it (no posting):**
```bash
npx ts-node scripts/dry-run.ts 2.2.0 --parity   # build reference, audit each SDK, print the report
```

**Roadmap (not in the first cut):** open/update tracking issues on lagging SDK repos on beta/RC; a failing status check on FINAL when not at parity; PR comments on SDK PRs touching `definitions.json`. These are deferred because they write to other repos (need `issues:write` / status scope) — the first cut only reads and posts to Mattermost.

## Deployment

Deployed to GCP Cloud Run via Cloud Build:

```bash
gcloud builds submit --config=cloudbuild.yaml
```

### GCP Resources Required

- **Cloud Run** service
- **Secret Manager** secret `APP_SECRETS` (JSON blob with all credentials, including `POLLER_TOKEN`)
- **Cloud Storage** bucket for poller state
- **Cloud Scheduler** job hitting `POST /poll` every 15 minutes, with header `X-Cloud-Scheduler-Token: <POLLER_TOKEN>`

### Cloud Scheduler setup

```bash
POLLER_TOKEN=$(openssl rand -hex 32)
# Put this same value in APP_SECRETS.POLLER_TOKEN
gcloud scheduler jobs create http xrplf-release-notifier-poll \
    --location=us-central1 \
    --schedule="*/15 * * * *" \
    --uri="https://<service-url>/poll" \
    --http-method=POST \
    --headers="X-Cloud-Scheduler-Token=$POLLER_TOKEN"
```

If the job already exists, update its headers with `gcloud scheduler jobs update http xrplf-release-notifier-poll --location=us-central1 --update-headers="X-Cloud-Scheduler-Token=$POLLER_TOKEN"`.

## Recurring reports (the scheduler)

Anything that runs on a calendar — weekly digests, daily countdowns — is declared in
[`config/schedules.yaml`](config/schedules.yaml), not in `gcloud`. **One** Cloud Scheduler
job POSTs `/tick` every 5 minutes and the dispatcher decides what is due, so adding a
report costs a handler plus five lines of YAML — no new job, no new route, no new secret.

```yaml
jobs:
  - name: unl-pr-queue
    cron: '0 9 * * MON'
    tz: Europe/Amsterdam
    handler: unlPrQueue
    enabled: true
```

Current jobs:

| Job | When | What |
|---|---|---|
| `weekly-update` | Fri 16:00 CET | Drafts the weekly team update from the week's GitHub activity, tagged `[partner]`/`[board]`/`[internal]`. A **draft to edit**, not a final post — it only sees pushed work. Author defaults to `dangell7`, override with `WEEKLY_UPDATE_AUTHOR`. |
| `validator-review` | Mon 09:00 CET | dUNL reliability review — 30d agreement, version spread, and any member that is partial-only, revoked, or invisible to the data source. Membership from `XRPLF/unl` (data.xrpl.org cannot see `unl.xrplf.org`); agreement from data.xrpl.org. Reliability only — engagement is tracked separately. |
| `validator-toml` | 1st of month, 09:00 CET | XLS-50 / domain-verification sweep — who publishes an `xrp-ledger.toml` listing their own key, who declares `network_asn` (a MUST), ASN/country concentration, and declared hardware. The only automated source of the validator hardware inventory. |
| `unl-pr-queue` | Mon 09:00 CET | Open PRs on `XRPLF/unl`, split into inclusion / removal / housekeeping, flagged past 60 days. |

`handler` must name an entry in `src/scheduler/handlers.ts`. The table is parsed and fully
validated at startup — a bad cron expression, an unknown timezone, or a typo'd handler
crashes the deploy rather than becoming a job that silently never fires.

A job is due when at least one cron occurrence has passed since its **last successful**
run. Two consequences worth knowing:

- Downtime spanning three weekly slots produces **one** catch-up run, not three.
- A handler that throws does **not** advance `lastRun`, so it retries on the next 5-minute
  tick instead of waiting a week. After 3 consecutive failures the notifier posts about
  its own breakage.

A job seen for the first time is recorded without running, so a fresh deploy doesn't fire
every report at once.

```bash
# One-time: the only scheduler job you need
gcloud scheduler jobs create http xrplf-release-notifier-tick \
    --location=us-central1 \
    --schedule="*/5 * * * *" \
    --uri="https://<service-url>/tick" \
    --http-method=POST \
    --headers="X-Cloud-Scheduler-Token=$POLLER_TOKEN"

# What would run right now, posting nothing
curl -sX POST "$SERVICE_URL/tick" \
    -H "X-Cloud-Scheduler-Token: $POLLER_TOKEN" \
    -H 'content-type: application/json' -d '{"dryRun":true}' | jq

# Did the weekly report fire, and when is the next one?
curl -s "$SERVICE_URL/schedules" \
    -H "X-Cloud-Scheduler-Token: $POLLER_TOKEN" | jq
```

State lives at `gs://xrplf-release-notifier/scheduler-state.json` as
`{ jobs: { <name>: { lastRun, failures } } }`. Renaming a job resets its history.

### GitHub App Setup

1. Create at `github.com/organizations/XRPLF/settings/apps/new`
2. Permissions: Repository contents (Read-only)
3. Subscribe to events: **Push** AND **Release**
4. Install on **both** `XRPLF/rippled` and `XRPLF/xrpld-private`
5. Set webhook URL to Cloud Run service URL + `/webhook`

The same webhook URL and secret serve both repos. Each webhook payload
carries `repository.full_name`, which the service uses to look up the repo
in its allow-list (see [src/github/repos.ts](src/github/repos.ts)) and apply
the right notification policy (see "Dual-repo dedup" below). Events from
any repo not in that list return `200 ignored`.

## Version Types

| Type | Pattern | Example |
|------|---------|---------|
| Beta | `X.Y.Z-bN` | `3.2.0-b4` |
| RC | `X.Y.Z-rcN` | `3.1.0-rc1` |
| Final | `X.Y.Z` | `3.1.0` |

Tag refs may carry an optional `v` prefix (e.g. `v3.1.0`); we strip it before matching.

## Delivery matrix

What fires Mattermost vs Twitter, per event × per repo. **`yes` = posts every time the event arrives** (no dedup); `—` = no post.

| Event | Repo | Mattermost | Twitter |
|---|---|---|---|
| Branch push (any ref under `refs/heads/*`) | any | — | — |
| Tag deletion | any | — | — |
| Tag not matching version regex (e.g. `smart-escrow-devnet4`) | any | — | — |
| Tag push `X.Y.Z-bN` (BETA) | public | yes — `formatMattermost(TAG)` + AI commit-compare summary + [amendment-aware breaking-change scan](#breaking-change-detection) (red breaking / amber surface / blue none) | — |
| Tag push `X.Y.Z-bN` (BETA) | private | yes — grey `formatMattermostPrivateTagHeadsUp`, no body, no link (no diff scan — embargo) | — |
| Tag push `X.Y.Z-rcN` (RC) | public | yes — `formatMattermost(TAG)` + AI commit-compare summary + breaking-change scan (red/amber/blue) | — |
| Tag push `X.Y.Z-rcN` (RC) | private | yes — grey `formatMattermostPrivateTagHeadsUp` | — |
| Tag push `X.Y.Z` (FINAL) | public | yes — `formatMattermost(TAG)` + AI commit-compare summary + breaking-change scan (red/amber/blue) | — |
| Tag push `X.Y.Z` (FINAL) | private | yes — grey `formatMattermostPrivateTagHeadsUp` | — |
| `release.published` (draft) | any | — | — |
| `release.published` RC | public | yes — orange `formatMattermost(RELEASE)` + AI body summary | — |
| `release.published` RC | private | yes — grey `formatMattermostPrivateReleaseHeadsUp` + AI summary of payload body | — |
| `release.published` FINAL | public | — (suppressed: the binary-poll post gates on this release existing and repeats it with strictly more — install commands, breaking/surface report, tweet) | — |
| `release.published` FINAL | private | yes — grey `formatMattermostPrivateReleaseHeadsUp` + AI summary of payload body | — |
| Binary `.deb`/`.rpm` on `pool/stable/` for a FINAL | (treated as public) | yes — green `formatMattermost(BINARY_POLL)` + install commands + deterministic breaking/surface report; also fires the one SDK/docs parity scan | **yes** (when `TWITTER_POSTING_ENABLED=true`) — release-card PNG + `Release notes: …` link |
| Binary on `pool/stable/` for non-FINAL | — | — | — |

### Lifecycle of one FINAL release

For a final like `3.2.0`, expect over hours-to-days:

```
git tag 3.2.0 pushed              → 1 Mattermost post  (blue tag, surface report + commit-compare summary)
GitHub Release 3.2.0 published    → no post            (binary-poll announcement owns it)
.deb/.rpm on pool/stable/         → 1 Mattermost post  (green binary, install commands + full report)
                                  + 1 tweet            (image + release-notes link, "install now")
                                  + 1 parity report    (SDK + docs parity, fired once from this path)
                                   ─────────────────────────────
                          Total:    2 Mattermost posts + 1 tweet + 1 parity report
```

If the same release also hits xrpld-private with a tag push and release publish, add **2 more** grey Mattermost heads-ups (no tweets).

An RC ships up to 2 Mattermost posts (tag + release-published) + **0 tweets**. A BETA ships 1 Mattermost post + 0 tweets. Twitter only ever fires for the FINAL binary-on-stable event.

## Breaking-change detection

Every **public tag push** (beta/RC/final) runs an **amendment-aware**, diff-based scan in parallel with the normal summary, and prepends up to two sections to the Mattermost post:

- **🚨 Breaking on upgrade** (red `#E53935`) — unconditional changes that take effect the moment the new binary runs (operators act now). AI-detected.
- **✨ New protocol surface — SDKs must add support** (amber `#FF9800`) — the new **amendments, transaction types, fields, and ledger objects** an SDK/integrator must implement so users can build/sign/parse them. Deterministic, not inferred.

### The two surfaces (and why they're handled differently)

rippled breaks in two unrelated ways:

1. **Breaking on upgrade** — a change that takes effect *unconditionally* when the binary runs (a serialization change, a default-`api_version` field rename, a config syntax change). This needs judgment, so it's the AI's job. The decisive subtlety: a transactor/consensus change **behind an amendment is inert on release day** (it only activates after 80%/2-week voting flips `rules().enabled(featureX)` true), so it is **not** breaking-on-upgrade. A naive scan that flags every changed `.cpp` produces false positives — the verify stage reads the governing source to confirm there's no gate.

2. **New protocol surface** — what an SDK must *add*. This is **not** the server's internal validation logic (an SDK never replicates enable-gated checks); it's the new wire/representation surface, which is exactly the canonical **definition macros**: `features.macro` (amendments), `transactions.macro` (tx types), `sfields.macro` (fields), `ledger_entries.macro` (ledger objects) — the same surface `ripple-binary-codec` / `definitions.json` encodes. `parseSurfaceChanges` ([`src/ai/breaking-rules.ts`](src/ai/breaking-rules.ts)) reads the added macro lines **deterministically**, so it's exact — no AI, no hedging, no guessing.

The domain rules grounding the AI classifier — gating, API versioning, serialization/TER freezes, additive-vs-breaking — live in `breaking-rules.ts`, researched against the `xrpld` source.

### Pipeline (`src/ai/breaking.ts`)

1. **Context** — resolve the predecessor (`findPredecessorTag`) and `fetchCompare` the diff (commits + file patches).
2. **New surface (B)** — `parseSurfaceChanges` over the definition-macro diffs. Amendments / tx types / ledger objects are listed; the many new SFields are collapsed to a count + sample (a feature-heavy release like `2.3.0` adds 400+ fields).
3. **Breaking-on-upgrade (A)** — two-stage AI: Stage 1 lists unconditional-change candidates from priority-path patches; Stage 2 verifies each by fetching the **governing source at the tag** (`getFileAtRef`) to confirm there's no amendment gate, returning a definitive `BREAKING_NOW` / `NOT_BREAKING` verdict. Low-confidence and **hedged** verdicts (contain "may/might/could/…") are dropped.

Colour escalates red (breaking-on-upgrade) → amber (new-surface-only) → blue (nothing). The scan is **best-effort** — any GitHub/AI failure degrades to "no section" and never blocks the tag post. The narrative summary on this path runs with `labelBreaking: false` so it never adds a second, contradictory breaking section. `release.published`, private heads-up, and binary-poll posts have no diff scan and keep their AI-labeled **Breaking changes** / **Other changes** split.

**Scope / future:** `XRPLF/rippled` tags only. The private mirror stays a bare heads-up (embargo). `summarizeBreakingForTag` is repo/trigger-agnostic, so a nightly `develop` scan or private wiring is a small follow-on. The detector is **decoupled** from the SDK parity checker (`src/parity`), which independently tracks whether SDKs implemented the surface. `GITHUB_TOKEN` is recommended (anonymous GitHub is 60 req/hr; the verify stage fetches source files).

Preview any tag's scan without posting:

```
npx ts-node scripts/dry-run.ts 3.2.0-b7      # shows the BREAKING-CHANGE SCAN block + composed post
```

### Twitter image (release card)

`assets/release-card-template.svg` is the template. `{{VERSION}}` is substituted at render time and the file is rendered to a 1200×675 PNG via `@resvg/resvg-js` (in-process, no headless browser). The PNG is uploaded via Twitter's v1.1 `media/upload`, then attached to the v2 tweet via `media_ids`. To iterate on the card, edit the SVG and run:

```bash
npx ts-node scripts/dry-run.ts 3.2.0 --final
open /tmp/release-card-3.2.0.png
```

Dry-run prints the exact tweet text (AI summary + release-notes URL) and saves the PNG locally; **no upload happens**.

### Dual-repo policy

Both repos are registered as webhook sources (see [src/github/repos.ts](src/github/repos.ts)) but they post different content:

| Source repo | Mattermost copy | Twitter | Content source |
|---|---|---|---|
| `XRPLF/rippled` (public) | canonical (blue / orange / green) with full AI summary | only the FINAL binary-on-stable event (tag pushes & release publishes never tweet) | release body in payload, falls back to GitHub API (release notes / commit-compare) |
| `XRPLF/xrpld-private` | grey "heads-up" with minimal content (bare tag) or payload-body-summary (release publish) | **never** | webhook payload only — no GitHub API call |

The motivation for the private heads-up: maintainers may cut several RCs on the private mirror before any public push lands, so without a signal the community gets the final public release with no prior warning.

Private heads-up shapes:
- **Tag push (any type)** → grey post: `:lock: rippled \`3.2.0-rc4\` tagged on \`XRPLF/xrpld-private\` (abc1234) — public mirror expected to follow.` No body, no link.
- **Release published (RC/FINAL)** → grey post with the AI-summarized release body **from the webhook payload** (no `fetchReleaseBody` call). If the payload body is empty, the post still goes out with `_No release notes in webhook payload._` placeholder.

Anything that would require a GitHub API call on the private repo is skipped — that means the commit-compare path is unreachable on private. This keeps permissions simple and means our notifier never has to read embargoed code or commit messages it doesn't already have in the webhook payload.

**Twitter is never invoked for private events**, regardless of channel configuration.

### Binary poll repo fallback

The binary poller has no webhook to identify the source repo. It tries
`GET /repos/XRPLF/rippled/releases/tags/{tag}` first for the release body;
if that's a 404 it falls back to `XRPLF/xrpld-private`. The fallback only
steers which API endpoint the AI summarizer reads — the announcement
itself is always posted as a public-repo notification (the binary is on
public stable, so the release IS public regardless of where the Release
object happens to live).

### AI summaries

`ANTHROPIC_API_KEY` is required (the service fails fast at config load if missing). When summarization runs, Claude Haiku 4.5 generates:
- A Markdown bullet list for the Mattermost attachment (always).
- A single tweet (≤280 chars including hashtags) for Twitter — **only when the caller passes `includeTwitter` (the final binary-poll path).** Beta/RC tag pushes and release publishes skip the tweet call entirely, so a discarded over-length tweet can never fail their Mattermost post. The tweet refers to the build as "XRP Ledger version X.Y.Z" and ends with `#XRPLedger`.

If a requested AI call fails — empty response, rate limit, network error, over-length tweet — the whole notification throws and nothing posts. No static fallback copy exists. The Mattermost shells (colors, emoji, pretext, install commands) are real UI structure, not fallback content.

Two summarization paths:

1. **Release body path**: when a GitHub Release exists for the tag, summarize its body under "**What's in this release:**".
2. **Commit-compare path** (used by beta tag pushes — no Release object exists): list version tags, find the right predecessor, fetch commits via the Compare API, summarize those under "**Preliminary changes since `{prior-tag}`** _(no GitHub Release published yet — summarized from raw commits)_".

The base-tag picker is type-aware:
- For prereleases (beta/RC): use the closest semver predecessor — tight delta between iterations.
- For finals: skip prereleases, compare against the last stable — what operators actually want to know.

Cost is trivial (a few thousand input tokens per release, ~$0.002 per call on Haiku 4.5).
