# Contributing to xrplf-release-notifier

Thanks for working on this. This document covers the most common changes — iterating on notification copy, adjusting AI prompts, adding a new event type — without forcing you to read every file.

## Repo layout

```
src/
  index.ts                Express server: /webhook (push, release, ping), /poll, /
  config.ts               Loads env / Secret Manager into a typed AppConfig
  webhook/
    verify.ts             HMAC-SHA256 verification of GitHub webhook signatures
    handler.ts            Push branch/tag dispatch + release-event handler
  poller/
    binary-checker.ts     repos.ripple.com scrape + version compare
    state.ts              GCS-backed last-seen versions
  version/
    parser.ts             classifyVersion(): "3.2.0-b6" → {major, minor, patch, type, ...}
    types.ts              VersionInfo, VersionType, NotificationSource
  github/
    client.ts             fetchFileContent, fetchReleaseBody, listVersionTags, compareCommits
  notifications/
    formatter.ts          Renders Mattermost + Twitter messages per scenario
    mattermost.ts         POST to Mattermost incoming webhook
    twitter.ts            twitter-api-v2 client wrapper
  ai/
    summarizer.ts         Claude Haiku 4.5 — dual-prompt (Mattermost + Twitter) summarization

scripts/
  dry-run.ts              Renders every scenario for a tag without posting anywhere

test/                     Jest unit tests + fixtures
```

## Iterating on notification copy (comms person)

If you want to change what gets posted to Mattermost or Twitter, you're almost certainly editing one of these three places:

| Want to change… | File | What's in there |
| --- | --- | --- |
| **Mattermost summary style** (bullets, ordering, emphasis) | [src/ai/summarizer.ts](src/ai/summarizer.ts) | `MATTERMOST_RELEASE_PROMPT` (for releases with curated notes), `MATTERMOST_COMMITS_PROMPT` (for the commit-compare fallback) |
| **Twitter tweet style** (length, framing, hashtags) | [src/ai/summarizer.ts](src/ai/summarizer.ts) | `TWITTER_PROMPT` |
| **Static text per scenario** (pretext, link button labels, fallback Twitter copy when AI is off, colors, emojis) | [src/notifications/formatter.ts](src/notifications/formatter.ts) | `format{Webhook,Tag,Release,Binary}Messages`, `COLOR_*`, `USERNAME`, `ICON_URL`, `FOOTER` |

### Iteration loop

1. Edit a prompt or template.
2. `npm run build`
3. `npx ts-node scripts/dry-run.ts 3.2.0-b6` — prints every scenario, posts nothing.
4. Compare to previous output, iterate.
5. When happy, commit.
6. To actually deploy: `gcloud builds submit --config=cloudbuild.yaml` (in the GCP project that owns the Cloud Run service).

### Pick a tag

`scripts/dry-run.ts` defaults to the most recent beta tag in `XRPLF/rippled`. Pass a tag explicitly to render a different one:

```bash
npx ts-node scripts/dry-run.ts 3.1.3       # release with curated GitHub Release body
npx ts-node scripts/dry-run.ts 3.2.0-b6    # beta with no Release → commit-compare fallback
npx ts-node scripts/dry-run.ts 3.2.0-b6 --json   # machine-readable
```

The script needs `ANTHROPIC_API_KEY` in `.env` to exercise AI summarization. Without it, summaries come back `null` and you'll see the unsummarized base templates only.

## Adding a new event type

Three places to touch:

1. **`src/version/types.ts`** — add a new `NotificationSource` enum value.
2. **`src/webhook/handler.ts`** or **`src/index.ts`** — add the dispatch path that calls `summarizeReleaseByTag(...)` (or your own data fetch) and then `formatMessages(version, source, summaries)`.
3. **`src/notifications/formatter.ts`** — add a `format*Messages(version)` function that returns the bare `{ mattermost, twitter }` template, and add a switch case in `formatMessages`.

Then update [README.md](README.md)'s **Notification Scenarios** table and add unit tests under `test/unit/notifications/formatter.test.ts` + `test/unit/webhook/handler.test.ts`.

## Testing

```bash
npm test
```

Tests run offline against fixtures in `test/fixtures/`. The AI summarizer is exercised by `scripts/dry-run.ts` against the live GitHub API + Anthropic API (which needs an API key); there are no unit tests that hit Anthropic.

## Deploy

The service runs on Cloud Run in the `xrplf-release-notifier` GCP project.

```bash
gcloud builds submit --config=cloudbuild.yaml
```

Secrets are managed in GCP Secret Manager under the secret name `APP_SECRETS` (a JSON blob mirroring `.env.json`). To update secrets:

1. Edit `.env.json` locally (do **not** commit the real values).
2. `gcloud secrets versions add APP_SECRETS --data-file=.env.json`
3. Force Cloud Run to pick up the new version: `gcloud run services update xrplf-release-notifier --region=us-central1 --update-env-vars="_RESTART=$(date +%s)"` (or just redeploy).

## Style

- TypeScript strict mode; `npm run build` must pass.
- One file per concern. If you need a new module, give it its own file under the appropriate folder rather than tacking it onto an existing one.
- No `console.log` in production code paths — use the Winston `logger` passed through the handlers.
- Notifications must never crash the webhook handler. Wrap external calls (`postToMattermost`, `postToTwitter`, `client.messages.create`) so a failure logs and returns `null`/falls through, but the HTTP response is still `200`. The webhook is GitHub-facing; a non-2xx triggers retry storms.
