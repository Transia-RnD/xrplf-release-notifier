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

Take the release info and produce ONE tweet. Hard rules:
- MAX 270 characters including hashtags. Count carefully — leave headroom.
- End with: #XRPLedger #rippled
- Mention the version number explicitly (e.g. "rippled 3.2.0-b6").
- Lead with the single most newsworthy item: security/breaking > major feature > general announcement.
- Plain text only — no markdown, no quotes around the tweet, no preamble.
- Audience: XRPL node operators and developers; technical but skim-reading.
- If no substantive content (e.g. routine beta bump), just announce the version cleanly.
- Output ONLY the tweet text. Nothing before, nothing after.`

export interface Summaries {
  /** Markdown-shaped, multi-line, with leading header. Goes in Mattermost attachment body. */
  mattermost: string | null
  /** Single line, ≤280 chars including hashtags. Replaces the default Twitter text. */
  twitter: string | null
}

const EMPTY: Summaries = { mattermost: null, twitter: null }

export interface SummarizeOptions {
  owner: string
  repo: string
  tag: string
  apiKey?: string
  githubToken?: string
  logger?: Logger
}

/**
 * Top-level: try GitHub Release body first, then commit-compare fallback.
 * Returns both Mattermost and Twitter shaped summaries from one source.
 */
export async function summarizeReleaseByTag(
  opts: SummarizeOptions
): Promise<Summaries> {
  if (!opts.apiKey) {
    opts.logger?.info('Skipping AI summary — no ANTHROPIC_API_KEY configured')
    return EMPTY
  }

  let body: string | null = null
  try {
    body = await fetchReleaseBody(
      opts.owner,
      opts.repo,
      opts.tag,
      opts.githubToken
    )
  } catch (err) {
    opts.logger?.warn('Failed to fetch release body for summary', {
      tag: opts.tag,
      error: err instanceof Error ? err.message : String(err),
    })
  }

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
  let tags: string[]
  try {
    tags = await listVersionTags(opts.owner, opts.repo, opts.githubToken)
  } catch (err) {
    opts.logger?.warn('Failed to list tags for commit-compare', {
      error: err instanceof Error ? err.message : String(err),
    })
    return EMPTY
  }

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
    opts.logger?.info('No predecessor tag found for commit-compare', {
      tag: opts.tag,
    })
    return EMPTY
  }

  let commits: CommitSummary[] | null
  try {
    commits = await compareCommits(
      opts.owner,
      opts.repo,
      prior.raw,
      opts.tag,
      opts.githubToken
    )
  } catch (err) {
    opts.logger?.warn('Compare API failed', {
      base: prior.raw,
      head: opts.tag,
      error: err instanceof Error ? err.message : String(err),
    })
    return EMPTY
  }

  if (!commits || commits.length === 0) {
    opts.logger?.info('No commits between predecessor and target', {
      base: prior.raw,
      head: opts.tag,
    })
    return EMPTY
  }

  // apiKey is guaranteed by the top of summarizeReleaseByTag, which is the
  // only caller of summarizeCommitsSinceLast.
  if (!opts.apiKey) return EMPTY
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
    return {
      mattermost: `**Preliminary changes since \`${baseTag}\`** _(no GitHub Release published yet — summarized from raw commits)_:\n• No notable changes since ${baseTag}.`,
      twitter: `rippled ${tag} tagged — no notable changes since ${baseTag}. #XRPLedger #rippled`,
    }
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

/** Fires both AI calls in parallel for low latency and bundles them up. */
async function runBothPrompts(opts: RunBothOpts): Promise<Summaries> {
  const client = new Anthropic({ apiKey: opts.apiKey })

  const mattermostCall = client.messages
    .create({
      model: MODEL,
      max_tokens: MAX_TOKENS_MATTERMOST,
      system: opts.mattermostSystem,
      messages: [{ role: 'user', content: opts.mattermostUser }],
    })
    .then((r) => extractText(r))
    .catch((err) => {
      opts.logger?.warn('Mattermost summarization failed', {
        tag: opts.tag,
        source: opts.source,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    })

  const twitterCall = client.messages
    .create({
      model: MODEL,
      max_tokens: MAX_TOKENS_TWITTER,
      system: TWITTER_PROMPT,
      messages: [{ role: 'user', content: opts.twitterUser }],
    })
    .then((r) => extractText(r))
    .catch((err) => {
      opts.logger?.warn('Twitter summarization failed', {
        tag: opts.tag,
        source: opts.source,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    })

  const [mmText, twText] = await Promise.all([mattermostCall, twitterCall])

  opts.logger?.info('Generated AI summaries', {
    tag: opts.tag,
    source: opts.source,
    mattermost_chars: mmText?.length ?? 0,
    twitter_chars: twText?.length ?? 0,
  })

  return {
    mattermost: mmText ? `${opts.mattermostHeader}\n${mmText}` : null,
    twitter: twText && twText.length <= TWITTER_MAX_CHARS ? twText : null,
  }
}

function extractText(response: Anthropic.Message): string | null {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  return text || null
}
