# xrplf-release-notifier

Automated release notifications for rippled version changes. Monitors both [XRPLF/rippled](https://github.com/XRPLF/rippled) (public) and [XRPLF/xrpld-private](https://github.com/XRPLF/xrpld-private) (private), plus the official binary package repository (repos.ripple.com), and broadcasts release updates to Mattermost and Twitter/X.

## How It Works

A single rippled release fires through several upstream events (source bump, tag, GitHub Release, binary publish) — and now those events fire **twice**, once from `XRPLF/rippled` (public) and once from `XRPLF/xrpld-private` (private). To avoid spamming the same announcement multiple times, the service picks **one canonical event per version type** and additionally deduplicates across repos:

| Version type | Canonical event | Notifications per release |
|---|---|---|
| **BETA** (`X.Y.Z-bN`) | Tag push | 1 |
| **RC** (`X.Y.Z-rcN`) | GitHub Release published | 1 |
| **FINAL** (`X.Y.Z`) | GitHub Release published, then binary on `pool/stable/` | 2 (release notes, then install-now) |

Every other event (branch pushes / source bumps, tag pushes for RC and FINAL) is acknowledged with a `200 ignored` and posts nothing. The service fails hard if AI summarization breaks — no fallback copy ever reaches a public channel.

**Webhook path:** A GitHub App delivers push and release events. `/webhook` dispatches by `X-GitHub-Event`:
- `push` to `refs/tags/X.Y.Z-bN` (or `vX.Y.Z-bN`) → BETA tag notification
- `push` to any branch → ignored
- `push` to non-beta tag (`X.Y.Z`, `X.Y.Z-rcN`) → ignored (GitHub Release event handles those)
- `release` with `action: published`, not draft → RC or FINAL notification (uses the release body)

**Polling path:** Cloud Scheduler triggers `/poll` every 15 minutes. The service scrapes `pool/stable/` on repos.ripple.com for new `.deb`/`.rpm` packages and notifies when a new FINAL binary appears. RC/beta builds live on `pool/unstable/` which is not polled.

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

## Notification Scenarios

Each rippled release fires through many upstream events but the service only posts on the **one** canonical event per version type. Here's what posts, when, and what it looks like:

| Scenario | Trigger | Version types | Color | Summary source |
|----------|---------|---------------|-------|----------------|
| **BETA tag pushed** | `push` event with `ref: refs/tags/X.Y.Z-bN` | BETA | light blue (`#2196F3`) | Commit-compare since previous beta (no GitHub Release exists) |
| **RC published** | `release` event, `action: published`, prerelease | RC | orange (`#FF9800`) | Curated Release body from payload |
| **FINAL published** | `release` event, `action: published`, not prerelease | FINAL | green (`#4CAF50`) | Curated Release body from payload |
| **FINAL binary on stable** | `/poll` detects new `.deb`/`.rpm` on `pool/stable/` | FINAL | green (`#4CAF50`) | Curated Release body fetched from GitHub |

### Lifecycle of one release

For a typical final release like `3.2.0`, expect this sequence over hours-to-days:

```
BuildInfo.cpp bump (release-3.2)   → ignored (no notification)
git tag 3.2.0 pushed               → ignored (release event will notify)
GitHub Release 3.2.0 published     → FINAL published  (1 notification)
.deb/.rpm appear on pool/stable/   → FINAL binary on stable  (1 notification on next /poll tick)
```

So a final ships **2 notifications**, an RC ships **1** (release-published), a beta ships **1** (tag push).

### Filtering rules

- **Branch pushes**: all ignored. Source bumps no longer notify — the tag/release event is the canonical announcement.
- **Tag pushes**: only BETA tags notify (`X.Y.Z-bN`). RC and FINAL tag pushes are ignored because the GitHub Release event covers them with better content (release notes).
- **Tag deletions**: ignored. Tags not matching the version regex (e.g. `smart-escrow-devnet4`): ignored.
- **Release events**: only `action: "published"`, not draft. RC publishes are kept (they have `prerelease: true`).
- **Binary poll**: only FINAL versions on `pool/stable/`. RC/beta binaries live on `pool/unstable/` which is not polled. If a non-final ever shows up on stable, the poll is logged and skipped.

### Dual-repo policy

Both `XRPLF/rippled` (public) and `XRPLF/xrpld-private` are registered as
webhook sources (see [src/github/repos.ts](src/github/repos.ts)) but they
follow different code paths:

| Source repo | Mattermost | Twitter | Content source |
|---|---|---|---|
| `XRPLF/rippled` (public) | canonical full post | yes | release body in payload, falls back to GitHub API (release notes / commit-compare) |
| `XRPLF/xrpld-private` | **heads-up only** | **never** | webhook payload only — no GitHub API call |

The motivation for the private heads-up: maintainers may cut several RCs
on the private mirror before any public push lands, so without a signal
the community gets the final public release with no prior warning. The
heads-up gives the "something is happening" signal without dragging in
broken links or embargoed content we'd have to fetch separately.

Private heads-up shape:
- **Tag push (BETA only)** → grey-bordered Mattermost post: `:lock: rippled \`3.2.0-b7\` tagged on \`XRPLF/xrpld-private\` (abc1234) — public mirror expected to follow.` No body, no link.
- **Release published (RC/FINAL)** → grey-bordered Mattermost post with the AI-summarized release body **from the webhook payload** (no `fetchReleaseBody` call). If the payload body is empty, the post still goes out with `_No release notes in webhook payload._` placeholder.

Anything that would require a GitHub API call on the private repo is
skipped — that means the commit-compare path is unreachable on private.
This keeps the GitHub App permissions story simple and means our
notifier never has to read embargoed code or commit messages it doesn't
already have.

Twitter is never invoked for private events, regardless of channel
configuration.

### Cross-event dedup

A small per-key claim ledger lives in the GCS bucket under
`dedup/{channel}-{scenario}-{version}.json`, using GCS's
`ifGenerationMatch: 0` precondition for atomic claim. This handles GitHub
redelivering the same webhook (network blip, manual replay) and the
`release`-event-vs-binary-poll overlap for finals. Dedup is **per
channel** — `mattermost:release:3.2.0` and `twitter:release:3.2.0` are
separate keys.

Critically, private heads-ups use **distinct scenarios**
(`tag-private`, `release-private`) so they never collide with the public
canonical posts (`tag`, `release`, `binary`). For a release that hits
both repos, expect two Mattermost posts: a grey heads-up when it lands on
private, and the canonical green/orange/blue post when public catches
up.

### Binary poll repo fallback

The binary poller has no webhook to identify the source repo. It tries
`GET /repos/XRPLF/rippled/releases/tags/{tag}` first for the release body;
if that's a 404 it falls back to `XRPLF/xrpld-private`. The fallback only
steers which API endpoint the AI summarizer reads — the announcement
itself is always posted as a public-repo notification (the binary is on
public stable, so the release IS public regardless of where the Release
object happens to live).

### AI summaries

`ANTHROPIC_API_KEY` is required (the service fails fast at config load if missing). When summarization runs, Claude Haiku 4.5 generates both:
- A Markdown bullet list for the Mattermost attachment
- A single tweet (≤270 chars including hashtags) for Twitter

If either AI call fails — empty response, rate limit, network error, over-length tweet — the whole notification throws and nothing posts. No static fallback copy exists. The Mattermost shells (colors, emoji, pretext, install commands) are real UI structure, not fallback content.

Two summarization paths:

1. **Release body path**: when a GitHub Release exists for the tag, summarize its body under "**What's in this release:**".
2. **Commit-compare path** (used by beta tag pushes — no Release object exists): list version tags, find the right predecessor, fetch commits via the Compare API, summarize those under "**Preliminary changes since `{prior-tag}`** _(no GitHub Release published yet — summarized from raw commits)_".

The base-tag picker is type-aware:
- For prereleases (beta/RC): use the closest semver predecessor — tight delta between iterations.
- For finals: skip prereleases, compare against the last stable — what operators actually want to know.

Cost is trivial (a few thousand input tokens per release, ~$0.002 per call on Haiku 4.5).
