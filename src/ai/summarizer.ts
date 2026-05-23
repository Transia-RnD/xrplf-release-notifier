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
The audience is XRPL node operators and the broader community. They only "do something" when the FINAL X.Y.Z release ships with binaries. Betas, RCs, tag pushes, and Release-published events are PROGRESS UPDATES, not products they consume. Your tweet is a stay-tuned alert that points at the upcoming final release as the thing that matters.

Derive the upcoming final version from the tag:
- "3.2.0-b7" → final is "3.2.0"
- "3.2.0-rc1" → final is "3.2.0"
- "3.2.0" → this IS the final (use different framing — see below)

Produce ONE tweet. Hard rules:
- MAX 270 characters including hashtags and emojis. Count carefully — leave headroom.
- End with: #XRPLedger #rippled
- Mention the current dev version explicitly (e.g. "rippled 3.2.0-b7") AND name the upcoming final ("on the road to 3.2.0", "stay tuned for 3.2.0", "3.2.0 is taking shape").
- Open with an emoji that fits the stage: 🧪 (beta), 🚀 (RC), 🏗️ (release-branch progress), 🏷️ (tag pushed), 📣 (release notes published), 🛡️ (security highlight), 🔥 (major feature highlight). Pick ONE.
- Use 1-3 emojis total. Never put an emoji directly next to a hashtag.
- Highlight 1-2 concrete things from the changes as a tight phrase (e.g. "MPT first-loss cover checks", "RPM/DEB packaging fixes") — keep it interesting but understated since the final isn't here yet.
- Use short, energetic sentences. Active voice. No corporate filler.
- Plain text only — no markdown, no bullet lists, no quotes around the tweet, no preamble.

BANNED phrasings (these imply the reader can act NOW, but they can't):
- "incoming", "is live", "is here", "now available", "available now"
- "preview it now", "get the preview ready", "try it now"
- "upgrade", "install", "deploy", "stay current", "operators should…"
- "apt-get", "yum", "via apt", "via yum", any package-manager reference

REQUIRED phrasings (forward-looking, stay-tuned energy):
- "on the road to <final>", "stay tuned for <final>", "<final> is taking shape"
- "what's brewing", "in flight", "next up", "early look", "work in progress"
- "tagged", "cut" (for tag-push moments)

EXCEPTION — if the tag itself is a FINAL (no -bN/-rcN suffix), this is the GitHub Release announcement moment. Frame it as: release notes are live, binaries coming next. Still no apt/yum/install language — that's a separate binary-available tweet.

If no substantive content (e.g. routine beta bump), keep the stay-tuned energy with a clean version progress note pointing at the upcoming final.

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
