# xrplf-release-notifier

Automated release notifications for rippled version changes. Monitors the [xrplf/rippled](https://github.com/XRPLF/rippled) repository and the official binary package repository (repos.ripple.com) to broadcast release updates to Mattermost and Twitter/X.

## How It Works

**Webhook path:** A GitHub App delivers push and release events. `/webhook` dispatches by `X-GitHub-Event`:
- `push` to `develop` / `release-*` modifying `BuildInfo.cpp` → beta / RC / final notification
- `push` to `refs/tags/X.Y.Z` (or `vX.Y.Z`) → tag notification
- `release` with `action: published` (not draft) → GitHub release notification

**Polling path:** Cloud Scheduler triggers `/poll` every 15 minutes. The service scrapes repos.ripple.com for new `.deb`/`.rpm` packages and notifies when a new binary appears.

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

## Deployment

Deployed to GCP Cloud Run via Cloud Build:

```bash
gcloud builds submit --config=cloudbuild.yaml
```

### GCP Resources Required

- **Cloud Run** service
- **Secret Manager** secret `APP_SECRETS` (JSON blob with all credentials)
- **Cloud Storage** bucket for poller state
- **Cloud Scheduler** job hitting `POST /poll` every 15 minutes

### GitHub App Setup

1. Create at `github.com/organizations/XRPLF/settings/apps/new`
2. Permissions: Repository contents (Read-only)
3. Subscribe to events: **Push** AND **Release**
4. Install on `XRPLF/rippled`
5. Set webhook URL to Cloud Run service URL + `/webhook`

## Version Types

| Type | Pattern | Example |
|------|---------|---------|
| Beta | `X.Y.Z-bN` | `3.2.0-b4` |
| RC | `X.Y.Z-rcN` | `3.1.0-rc1` |
| Final | `X.Y.Z` | `3.1.0` |

Tag refs may carry an optional `v` prefix (e.g. `v3.1.0`); we strip it before matching.

## Notification Scenarios

A single rippled release typically fires **multiple** notifications as it moves through the pipeline. Here's exactly when each one fires and what it looks like:

| # | Scenario | Trigger | Color | Summary source |
|---|----------|---------|-------|----------------|
| 1 | **BETA source bump** | `push` to `develop` modifying `BuildInfo.cpp` to `X.Y.Z-bN` | blue (`#3F51B5`) | Commit-compare (no GitHub Release expected) |
| 2 | **RC source bump** | `push` to `release-X.Y` modifying `BuildInfo.cpp` to `X.Y.Z-rcN` | orange (`#FF9800`) | Curated Release body if it exists, else commit-compare |
| 3 | **FINAL source bump** | `push` to `release-X.Y` modifying `BuildInfo.cpp` to `X.Y.Z` (no suffix) | green (`#4CAF50`) | Curated Release body if it exists, else commit-compare since last stable |
| 4 | **TAG push** | `push` event with `ref: refs/tags/X.Y.Z[-bN|-rcN]` | light blue (`#2196F3`) | Curated Release body if it exists, else commit-compare |
| 5 | **GitHub Release published** | `release` event with `action: published`, not draft | green (final) or orange (prerelease) | Curated Release body from the event payload |
| 6 | **Binary published** | Cloud Scheduler hits `/poll` every 15 min; new `.deb`/`.rpm` appears on repos.ripple.com | green (`#4CAF50`) | Curated Release body for the version, if it exists |

### Lifecycle of one release

For a typical final release like `3.2.0`, expect this sequence over hours-to-days:

```
BuildInfo.cpp bump (release-3.2)   → #3 FINAL source bump
git tag 3.2.0 pushed               → #4 TAG push
GitHub Release published           → #5 RELEASE published
.deb/.rpm appear on repos.ripple   → #6 BINARY published (next /poll tick)
```

Beta-track releases skip steps 5 (no Release object cut) and 6 (no binaries on repos.ripple.com), so a typical beta is just **#1 BETA source bump + #4 TAG push** — both with AI-summarized commit deltas if Anthropic API key is configured.

### Filtering rules

- **Branch filter**: webhook ignores pushes to any branch other than `develop` or `release-X.Y` (regex `/^refs\/heads\/(develop|release-\d+\.\d+)$/`).
- **File filter**: branch pushes that don't modify `src/libxrpl/protocol/BuildInfo.cpp` are ignored.
- **Tag filter**: tags that don't match the version regex (e.g. `smart-escrow-devnet4`) are ignored. Tag deletions are ignored.
- **Release filter**: only `action: "published"` events fire (not `edited`, `deleted`, `prereleased` lifecycle action). Draft releases are ignored.

### AI summaries

When `ANTHROPIC_API_KEY` is configured in `APP_SECRETS`, the formatter calls Claude Haiku 4.5 to summarize what's in the release. Two paths:

1. **Curated path**: Try `GET /repos/XRPLF/rippled/releases/tags/{tag}` for a Release body. If present, summarize it under "**What's in this release:**".
2. **Fallback path** (no Release object exists for the tag): list version tags, find the right predecessor, fetch commits via the Compare API, and summarize those under "**Preliminary changes since `{prior-tag}`** _(no GitHub Release published yet — summarized from raw commits)_".

The base-tag picker is type-aware:
- For prereleases (beta/RC): use the closest semver predecessor — tight delta between iterations.
- For finals: skip prereleases, compare against the last stable — what operators actually want to know.

Cost is trivial (a few thousand input tokens per release, ~$0.002 per call on Haiku 4.5). If `ANTHROPIC_API_KEY` is missing or summarization fails, notifications still fire without the summary — degrades gracefully.
