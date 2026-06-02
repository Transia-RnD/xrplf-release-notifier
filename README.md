# xrplf-release-notifier

Automated release notifications for rippled version changes. Monitors both [XRPLF/rippled](https://github.com/XRPLF/rippled) (public) and [XRPLF/xrpld-private](https://github.com/XRPLF/xrpld-private) (private), plus the official binary package repository (repos.ripple.com), and broadcasts release updates to Mattermost and Twitter/X.

## How It Works

A single rippled release fires through several upstream events (tag push, GitHub Release published, binary publish) and may fire **twice** — once from `XRPLF/rippled` (public) and once from `XRPLF/xrpld-private` (private).

**Every supported event posts.** No dedup, no canonical-event-per-version-type heuristics — duplicate signals are preferable to silent misses when maintainer workflow varies (tag-only on private, release-publish on public, both, etc.). A single public FINAL release can therefore produce **three** Mattermost posts and **three** tweets: tag push → release published → binary on stable. See the [delivery matrix](#delivery-matrix) below for the full rules.

The service fails hard if AI summarization breaks — no fallback copy ever reaches a public channel.

**Webhook path:** GitHub webhooks installed on both repos deliver `push` and `release` events to `/webhook`:
- `push` to `refs/tags/X.Y.Z[-bN|-rcN]` → tag notification (BETA / RC / FINAL all post)
- `push` to any branch → ignored
- `release` with `action: published`, not draft → release notification (uses the release body)

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

## Delivery matrix

The full set of rules: what fires Mattermost, what fires Twitter, per event × per repo. **`yes` = posts every time the event arrives** (no dedup), `—` = no post.

| Event | Repo | Mattermost | Twitter |
|---|---|---|---|
| Branch push (any ref under `refs/heads/*`) | any | — | — |
| Tag deletion | any | — | — |
| Tag not matching version regex (e.g. `smart-escrow-devnet4`) | any | — | — |
| Tag push `X.Y.Z-bN` (BETA) | public | yes — blue `formatMattermost(TAG)` + AI commit-compare summary | yes |
| Tag push `X.Y.Z-bN` (BETA) | private | yes — grey `formatMattermostPrivateTagHeadsUp`, no body, no link | — |
| Tag push `X.Y.Z-rcN` (RC) | public | yes — blue `formatMattermost(TAG)` + AI commit-compare summary | yes |
| Tag push `X.Y.Z-rcN` (RC) | private | yes — grey `formatMattermostPrivateTagHeadsUp` | — |
| Tag push `X.Y.Z` (FINAL) | public | yes — blue `formatMattermost(TAG)` + AI commit-compare summary | yes |
| Tag push `X.Y.Z` (FINAL) | private | yes — grey `formatMattermostPrivateTagHeadsUp` | — |
| `release.published` (draft) | any | — | — |
| `release.published` RC | public | yes — orange `formatMattermost(RELEASE)` + AI body summary | yes |
| `release.published` RC | private | yes — grey `formatMattermostPrivateReleaseHeadsUp` + AI summary of payload body | — |
| `release.published` FINAL | public | yes — green `formatMattermost(RELEASE)` + AI body summary | yes |
| `release.published` FINAL | private | yes — grey `formatMattermostPrivateReleaseHeadsUp` + AI summary of payload body | — |
| Binary `.deb`/`.rpm` on `pool/stable/` for a FINAL | (always posted as public) | yes — green `formatMattermost(BINARY_POLL)` + install commands | yes |
| Binary on `pool/stable/` for non-FINAL | — | — | — |

### Lifecycle of one FINAL release

For a final like `3.2.0`, expect over hours-to-days (with current "fire on every event" rules):

```
git tag 3.2.0 pushed              → 1 Mattermost post + 1 tweet  (blue tag, commit-compare summary)
GitHub Release 3.2.0 published    → 1 Mattermost post + 1 tweet  (green release, body summary)
.deb/.rpm on pool/stable/         → 1 Mattermost post + 1 tweet  (green binary, install commands)
                                   ─────────────────────────────
                          Total:    3 Mattermost posts + 3 tweets
```

If the same release also hits xrpld-private with a tag push and release publish, add **2 more** grey Mattermost heads-ups (no tweets).

An RC ships up to 2 Mattermost + 2 tweets (tag + release-published). A BETA ships 1 Mattermost + 1 tweet (tag push; betas rarely get a GitHub Release object).

### Dual-repo policy

Both repos are registered as webhook sources (see [src/github/repos.ts](src/github/repos.ts)) but they post different content:

| Source repo | Mattermost copy | Twitter | Content source |
|---|---|---|---|
| `XRPLF/rippled` (public) | canonical (blue / orange / green) with full AI summary | yes | release body in payload, falls back to GitHub API (release notes / commit-compare) |
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
