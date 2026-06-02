import Anthropic from '@anthropic-ai/sdk'
import type { Logger } from 'winston'
import type { CommitSummary } from '../github/client'
import {
  fetchReleaseBody,
  listVersionTags,
  compareCommits,
} from '../github/client'
import { compareVersions } from '../poller/binary-checker'

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS_MATTERMOST = 1024
const MAX_TOKENS_TWITTER = 200

/** Twitter's hard limit. Reject AI outputs longer than this. */
const TWITTER_MAX_CHARS = 280
/** Don't summarize tiny release bodies — they're usually just placeholders. */
export const MIN_RELEASE_BODY_CHARS = 20
/** Cap commits sent to Claude so large diffs don't blow the prompt. */
const MAX_COMMITS_FOR_SUMMARY = 80

const MATTERMOST_RELEASE_PROMPT = `You summarize rippled release notes for XRPL node operators.

Output 5-10 short bullet points in markdown (using • not -). Rules:
- Lead with SECURITY fixes and BREAKING / behavior changes.
- Then list significant new features.
- Then notable bug fixes.
- Skip routine docs/CI/test-only changes unless that's all that's in the release.
- Each bullet ≤ 120 chars. No preamble, no headings, no closing remarks — just the bullets.
- If you genuinely can't find anything substantive (release body is empty or boilerplate), output the single bullet: "• No notable changes."`

const MATTERMOST_COMMITS_PROMPT = `You summarize a list of git commits between two rippled tags for XRPL node operators.

Output 5-10 short bullet points in markdown (using • not -). Rules:
- Group related commits into one bullet — don't restate each commit verbatim.
- Lead with SECURITY fixes, BREAKING changes, and consensus / protocol / amendment changes.
- Then significant new features and behavior changes.
- Then notable bug fixes.
- Skip pure CI/test/docs/lint/style/refactor commits unless that's all there is.
- Skip merge commits, "version bump" commits, and "clang-format" commits.
- Each bullet ≤ 120 chars.
- Output ONLY the bullets — no preamble, no header, no "Preliminary changes since…" line, no closing remarks.
- If nothing substantive is in the commits, output the single bullet: "• No notable changes since the previous version."`

const TWITTER_PROMPT = `You write tweets (X posts) for rippled, the XRP Ledger reference server.

CRITICAL FRAMING — read this twice:
This tweet ONLY fires AFTER the FINAL X.Y.Z binary packages have shipped on repos.ripple.com (the public stable channel). The reader CAN install RIGHT NOW. This is the "operators, update your nodes" announcement — like a routine deploy notice — not a stay-tuned teaser. Tag is always FINAL (X.Y.Z, no -bN/-rcN suffix).

Your job: tell operators (a) the version is live, (b) why it matters in one tight phrase, (c) implicitly: act now.

Produce ONE tweet. Hard rules:
- MAX 195 characters including hashtags and emojis. Count carefully — a "Release notes: https://github.com/XRPLF/rippled/releases/tag/X.Y.Z" line will be appended programmatically, so leave room.
- End with: #XRPLedger #rippled
- Mention the version explicitly (e.g. "rippled 3.1.3" or "XRPL 3.1.3").
- Use action language. Operators should know what to do.
- Open with an emoji that fits: 📦 (default for binary release), 🛡️ (security release), 🔥 (major feature highlight), ⚠️ (urgent fix amendment / amendment activation).
- Use 1-2 emojis total. Never put an emoji directly next to a hashtag.
- Highlight 1-2 concrete things from the changes (e.g. "fixCleanup3_1_3 amendment", "MPT cover checks"). If the release contains an AMENDMENT that's in an activation period, prioritise that — it's the strongest "act now" signal.
- Short, energetic sentences. Active voice. No corporate filler.
- Plain text only — no markdown, no bullet lists, no quotes around the tweet, no preamble.

REQUIRED phrasings (this is install-now, embrace it):
- "is live", "is now available", "ships now"
- "update your nodes", "upgrade now", "install now"
- "operators: update", "node operators:"
- For amendments in activation: "activation period", "update before activation"

BANNED phrasings (the old "stay tuned" framing is gone):
- "coming next", "binaries coming", "stay tuned", "on the road to"
- "tagged", "cut", "in flight", "what's brewing"
- "release notes are live" — that's stale framing from the old release-publish-time tweet. Talk about the BINARIES being live.
- Package-manager commands in the tweet (apt-get / yum) — they're in the Mattermost post; tweet is one line of "update now" energy.

If no substantive content in the release notes, default to: "rippled X.Y.Z is now available — update your nodes. #XRPLedger #rippled"

Output ONLY the tweet text. Nothing before, nothing after.`

export interface Summaries {
  /** Markdown-shaped, multi-line, with leading header. Goes in Mattermost attachment body. */
  mattermost: string
  /** Single line, ≤280 chars including hashtags. The tweet body. */
  twitter: string
}

export interface SummarizeOptions {
  owner: string
  repo: string
  tag: string
  apiKey: string
  githubToken?: string
  logger?: Logger
}

/**
 * Top-level: try GitHub Release body first, then commit-compare fallback.
 * Throws on any failure — callers handle 5xx propagation. Returning a
 * partial/fallback would post garbage to public channels.
 */
export async function summarizeReleaseByTag(
  opts: SummarizeOptions
): Promise<Summaries> {
  const body = await fetchReleaseBody(
    opts.owner,
    opts.repo,
    opts.tag,
    opts.githubToken
  )

  if (body && body.trim().length >= MIN_RELEASE_BODY_CHARS) {
    return summarizeBody(body, opts.tag, opts.apiKey, opts.logger)
  }

  opts.logger?.info('No Release body found, falling back to commit-compare', {
    tag: opts.tag,
  })
  return summarizeCommitsSinceLast(opts)
}

/**
 * Summarize a known release body (used by the release event handler — body comes from payload).
 */
export async function summarizeBody(
  body: string,
  tag: string,
  apiKey: string,
  logger?: Logger
): Promise<Summaries> {
  const userMessage = `Summarize rippled ${tag} release notes:\n\n${body}`
  const twitterInput = `Version: rippled ${tag}\nRelease notes:\n${body}`
  return runBothPrompts({
    tag,
    apiKey,
    logger,
    mattermostSystem: MATTERMOST_RELEASE_PROMPT,
    mattermostUser: userMessage,
    mattermostHeader: `**What's in this release:**`,
    twitterUser: twitterInput,
    source: 'release-body',
  })
}

async function summarizeCommitsSinceLast(
  opts: SummarizeOptions
): Promise<Summaries> {
  const tags = await listVersionTags(opts.owner, opts.repo, opts.githubToken)

  const target = opts.tag.replace(/^v/, '')
  const targetIsFinal = !target.includes('-')
  const normalized = tags
    .map((t) => ({ raw: t, normalized: t.replace(/^v/, '') }))
    .filter((t) => t.normalized !== target)

  const predecessors = normalized
    .filter((t) => compareVersions(t.normalized, target) < 0)
    .filter((t) => (targetIsFinal ? !t.normalized.includes('-') : true))
    .sort((a, b) => compareVersions(a.normalized, b.normalized))

  const prior = predecessors.at(-1)
  if (!prior) {
    throw new Error(`No predecessor tag found for ${opts.tag}`)
  }

  const commits = await compareCommits(
    opts.owner,
    opts.repo,
    prior.raw,
    opts.tag,
    opts.githubToken
  )

  if (!commits || commits.length === 0) {
    throw new Error(
      `No commits between ${prior.raw} and ${opts.tag} — refusing to summarize an empty diff`
    )
  }

  return summarizeCommitsList(
    commits,
    opts.tag,
    prior.raw,
    opts.apiKey,
    opts.logger
  )
}

const TRIVIAL_COMMIT =
  /^(merge |bump version|version bump|set version|clang-format|format:)/i

async function summarizeCommitsList(
  commits: CommitSummary[],
  tag: string,
  baseTag: string,
  apiKey: string,
  logger?: Logger
): Promise<Summaries> {
  const filtered = commits
    .map((c) => ({ ...c, message: c.message.split('\n')[0].trim() }))
    .filter((c) => c.message && !TRIVIAL_COMMIT.test(c.message))
    .slice(0, MAX_COMMITS_FOR_SUMMARY)

  if (filtered.length === 0) {
    throw new Error(
      `All commits between ${baseTag} and ${tag} are trivial (merges/version bumps/format-only) — refusing to summarize`
    )
  }

  const commitList = filtered
    .map((c) => `- ${c.message} (${c.sha.slice(0, 7)}, ${c.author})`)
    .join('\n')

  return runBothPrompts({
    tag,
    apiKey,
    logger,
    mattermostSystem: MATTERMOST_COMMITS_PROMPT,
    mattermostUser: `Summarize commits between rippled ${baseTag} and ${tag}:\n\n${commitList}`,
    mattermostHeader: `**Preliminary changes since \`${baseTag}\`** _(no GitHub Release published yet — summarized from raw commits)_:`,
    twitterUser: `Version: rippled ${tag} (no GitHub Release published; tagged from develop/release branch)\nCommits since ${baseTag}:\n${commitList}`,
    source: `commits-since-${baseTag}`,
  })
}

interface RunBothOpts {
  tag: string
  apiKey: string
  logger?: Logger
  mattermostSystem: string
  mattermostUser: string
  mattermostHeader: string
  twitterUser: string
  source: string
}

/** Fires both AI calls in parallel for low latency. Any failure throws. */
async function runBothPrompts(opts: RunBothOpts): Promise<Summaries> {
  const client = new Anthropic({ apiKey: opts.apiKey })

  const mattermostCall = client.messages
    .create({
      model: MODEL,
      max_tokens: MAX_TOKENS_MATTERMOST,
      system: opts.mattermostSystem,
      messages: [{ role: 'user', content: opts.mattermostUser }],
    })
    .then((r) => extractText(r, 'mattermost'))

  const twitterCall = client.messages
    .create({
      model: MODEL,
      max_tokens: MAX_TOKENS_TWITTER,
      system: TWITTER_PROMPT,
      messages: [{ role: 'user', content: opts.twitterUser }],
    })
    .then((r) => extractText(r, 'twitter'))

  const [mmText, twText] = await Promise.all([mattermostCall, twitterCall])

  if (twText.length > TWITTER_MAX_CHARS) {
    throw new Error(
      `AI tweet exceeded ${TWITTER_MAX_CHARS} chars (${twText.length}) — refusing to post`
    )
  }

  opts.logger?.info('Generated AI summaries', {
    tag: opts.tag,
    source: opts.source,
    mattermost_chars: mmText.length,
    twitter_chars: twText.length,
  })

  return {
    mattermost: `${opts.mattermostHeader}\n${mmText}`,
    twitter: twText,
  }
}

function extractText(response: Anthropic.Message, channel: string): string {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  if (!text) {
    throw new Error(`Empty AI response for ${channel}`)
  }
  return text
}
