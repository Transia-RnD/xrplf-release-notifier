import type Anthropic from '@anthropic-ai/sdk'
import { createAnthropicClient } from './client'
import type { Logger } from 'winston'
import type { CommitSummary } from '../github/client'
import { fetchReleaseBody, compareCommits } from '../github/client'
import { findPredecessorTag } from '../version/predecessor'

export const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS_MATTERMOST = 1024
const MAX_TOKENS_TWITTER = 300

/**
 * Sanity cap on the AI tweet body. Above X's classic 280 because the complete
 * amendment list is never dropped for length (the account can post long-form);
 * the prompt still targets ~200 chars. This only catches runaway outputs.
 */
const TWITTER_MAX_CHARS = 500
/** Don't summarize tiny release bodies — they're usually just placeholders. */
export const MIN_RELEASE_BODY_CHARS = 20
/** Cap commits sent to Claude so large diffs don't blow the prompt. */
export const MAX_COMMITS_FOR_SUMMARY = 80

// Two variants per source. The LABELED variants emit an explicit "Breaking
// changes" section and are used wherever NO diff-based detection runs (release
// publishes, private heads-up, binary poll). The FLAT variants omit that
// section and are used on the tag-push path, where the authoritative
// diff-based detector (src/ai/breaking.ts) already prepends a breaking section
// — a second, message-only one would be redundant and can contradict it.

const MATTERMOST_RELEASE_PROMPT_LABELED = `You summarize xrpld release notes for XRPL node operators.

Output TWO labeled sections in markdown, exactly in this shape (use • not -):

**:warning: Breaking changes:**
• <each SECURITY fix, BREAKING change, or behavior/protocol/amendment change as one bullet>

**Other changes:**
• <significant new features, then notable bug fixes>

Rules:
- The "Breaking changes" section lists only changes that require operator/integrator action (API/RPC surface changes, removed/renamed fields, config defaults, consensus/amendment behavior, security fixes). If there are none, that section's single bullet is "• None".
- "Other changes" holds the rest: 4-8 bullets. Skip routine docs/CI/test-only changes unless that's all that's in the release.
- Each bullet ≤ 120 chars. Output ONLY the two labeled sections and their bullets — no preamble, no closing remarks.
- If the release body is empty or boilerplate, output "• None" under Breaking changes and "• No notable changes." under Other changes.`

const MATTERMOST_RELEASE_PROMPT_FLAT = `You summarize xrpld release notes for XRPL node operators.

Output 5-10 short bullet points in markdown (using • not -). Rules:
- Lead with SECURITY fixes and BREAKING / behavior changes.
- Then list significant new features.
- Then notable bug fixes.
- Skip routine docs/CI/test-only changes unless that's all that's in the release.
- Each bullet ≤ 120 chars. No preamble, no headings, no closing remarks — just the bullets.
- If you genuinely can't find anything substantive (release body is empty or boilerplate), output the single bullet: "• No notable changes."`

const MATTERMOST_COMMITS_PROMPT_LABELED = `You summarize a list of git commits between two xrpld tags for XRPL node operators.

Output TWO labeled sections in markdown, exactly in this shape (use • not -):

**:warning: Breaking changes:**
• <each SECURITY fix, BREAKING change, or consensus/protocol/amendment change as one bullet>

**Other changes:**
• <significant new features and behavior changes, then notable bug fixes>

Rules:
- The "Breaking changes" section lists only changes that require operator/integrator action (API/RPC surface changes, removed/renamed fields, config defaults, consensus/amendment behavior, security fixes). If there are none, that section's single bullet is "• None".
- "Other changes": group related commits into one bullet — don't restate each commit verbatim. 4-8 bullets.
- Skip pure CI/test/docs/lint/style/refactor commits, merge commits, "version bump" commits, and "clang-format" commits unless that's all there is.
- Each bullet ≤ 120 chars. Output ONLY the two labeled sections — no preamble, no "Preliminary changes since…" line, no closing remarks.
- If nothing substantive is in the commits, output "• None" under Breaking changes and "• No notable changes since the previous version." under Other changes.`

const MATTERMOST_COMMITS_PROMPT_FLAT = `You summarize a list of git commits between two xrpld tags for XRPL node operators.

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

const TWITTER_PROMPT = `You write tweets (X posts) announcing new releases of the XRP Ledger server software (known internally as "xrpld", but NEVER write that word in the tweet).

CRITICAL FRAMING — read this twice:
This tweet ONLY fires AFTER the FINAL X.Y.Z binary packages have shipped on repos.ripple.com (the public stable channel). The reader CAN install RIGHT NOW. This is the "operators, update your nodes" announcement — like a routine deploy notice — not a stay-tuned teaser. Tag is always FINAL (X.Y.Z, no -bN/-rcN suffix).

Your job: tell operators (a) the version is live, (b) exactly what protocol surface it ships — a compact release report — (c) implicitly: act now.

STRUCTURE (required) — write the tweet as TWO blocks with TWO BLANK LINES between them (i.e. three newline characters, "\\n\\n\\n"):
- Block 1 (one line): the announcement + call to action, ending right after the action (e.g. "update your nodes.").
- Block 2: the release report in this EXACT priority order, then the hashtag:
  1. AMENDMENTS. If the input contains an "Amendments in this release" list, name EVERY amendment on it, verbatim, as "Amendments: A, B, C". NEVER omit, group, count, or summarize any of them — "and more", "12 amendments", "including" are all banned. If no such list is supplied, name every amendment the release notes mention.
  2. SECURITY. If the release contains security fixes, say the area is hardened ("hardens Clawback invariants") — NEVER describe the fault, the vulnerability, or how it could be triggered.
  3. PERFORMANCE. One tight phrase, only if the release notes call one out.

The exact shape, both blank lines included:

XRP Ledger version 3.3.0 is now available - update your nodes.


Amendments: Sponsor, BatchV1_1, ConfidentialTransfer, fixCleanup3_3_0, PermissionDelegationV1_1, DynamicMPT. Hardens MPT invariants. Faster JSON parsing. #XRPLedger

Produce ONE tweet. Hard rules:
- Aim for under 200 characters including the hashtag — but the COMPLETE amendment list always beats the length target: never drop an amendment to save characters. A "Release notes: https://github.com/XRPLF/rippled/releases/tag/X.Y.Z" line will be appended programmatically, so leave room.
- End with: #XRPLedger
- Refer to the release as "XRP Ledger version X.Y.Z" (e.g. "XRP Ledger version 3.1.3"). Never write the word "xrpld" or "XRPL" in the tweet.
- Use plain hyphens "-" only. Never use em dashes (—) or en dashes (–) anywhere in the tweet.
- Use action language. Operators should know what to do.
- NO emojis or other pictographs anywhere in the tweet — plain text only.
- Amendment names are copied EXACTLY as given — never rename, expand, or prettify them.
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
- Package-manager commands in the tweet (apt-get / yum) — they're in the Mattermost post; the tweet is just "update now" energy.
- The words "xrpld" and "XRPL" anywhere in the tweet — always say "XRP Ledger version X.Y.Z".
- Em dashes (—) and en dashes (–) — use a plain hyphen "-" instead.
- Emojis and pictographs of any kind — the tweet is plain text only.

If no substantive content in the release notes, default to (both blank lines included):

XRP Ledger version X.Y.Z is now available - update your nodes.


#XRPLedger

Output ONLY the tweet text. Nothing before, nothing after.`

export interface Summaries {
  /** Markdown-shaped, multi-line, with leading header. Goes in Mattermost attachment body. */
  mattermost: string
  /**
   * Single line, ≤280 chars including hashtags. The tweet body.
   * Empty string when the caller did not request a tweet (includeTwitter
   * is false) — tweets are only ever posted from the final binary-poll path.
   */
  twitter: string
}

export interface SummarizeOptions {
  owner: string
  repo: string
  tag: string
  apiKey: string
  githubToken?: string
  logger?: Logger
  /**
   * Generate the tweet too. Defaults to false: only the final binary-poll
   * path tweets, so beta/RC/release webhook paths skip the Twitter AI call
   * entirely (saves a request and, critically, can't hard-fail the whole
   * notification on a discarded over-length tweet).
   */
  includeTwitter?: boolean
  /**
   * Emit a labeled "Breaking changes" section in the Mattermost summary.
   * Defaults to true. The tag-push path sets this false: the diff-based
   * detector (src/ai/breaking.ts) prepends the authoritative breaking section
   * there, so the narrative must not add a redundant message-only one.
   */
  labelBreaking?: boolean
  /**
   * Authoritative names of the votable amendments added this release (from the
   * deterministic surface scan). When set with includeTwitter, the tweet must
   * name every one of them verbatim — the AI never derives the list itself.
   */
  amendments?: string[]
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
    return summarizeBody(
      body,
      opts.tag,
      opts.apiKey,
      opts.logger,
      opts.includeTwitter,
      opts.labelBreaking,
      opts.amendments
    )
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
  logger?: Logger,
  includeTwitter = false,
  labelBreaking = true,
  amendments?: string[]
): Promise<Summaries> {
  const userMessage = `Summarize xrpld ${tag} release notes:\n\n${body}`
  const twitterInput = `Version: XRP Ledger version ${tag}\n${amendmentsBlock(amendments)}Release notes:\n${body}`
  return runBothPrompts({
    tag,
    apiKey,
    logger,
    mattermostSystem: labelBreaking
      ? MATTERMOST_RELEASE_PROMPT_LABELED
      : MATTERMOST_RELEASE_PROMPT_FLAT,
    mattermostUser: userMessage,
    mattermostHeader: `**What's in this release:**`,
    twitterUser: twitterInput,
    includeTwitter,
    source: 'release-body',
  })
}

async function summarizeCommitsSinceLast(
  opts: SummarizeOptions
): Promise<Summaries> {
  const prior = await findPredecessorTag(
    opts.owner,
    opts.repo,
    opts.tag,
    opts.githubToken
  )
  if (!prior) {
    throw new Error(`No predecessor tag found for ${opts.tag}`)
  }

  const commits = await compareCommits(
    opts.owner,
    opts.repo,
    prior,
    opts.tag,
    opts.githubToken
  )

  if (!commits || commits.length === 0) {
    throw new Error(
      `No commits between ${prior} and ${opts.tag} — refusing to summarize an empty diff`
    )
  }

  return summarizeCommitsList(
    commits,
    opts.tag,
    prior,
    opts.apiKey,
    opts.logger,
    opts.includeTwitter,
    opts.labelBreaking,
    opts.amendments
  )
}

/** The authoritative amendment list for the tweet input ('' when absent). */
function amendmentsBlock(amendments?: string[]): string {
  if (!amendments || amendments.length === 0) return ''
  return `Amendments in this release (name EVERY one in the tweet, verbatim): ${amendments.join(', ')}\n`
}

export const TRIVIAL_COMMIT =
  /^(merge |bump version|version bump|set version|clang-format|format:)/i

async function summarizeCommitsList(
  commits: CommitSummary[],
  tag: string,
  baseTag: string,
  apiKey: string,
  logger?: Logger,
  includeTwitter = false,
  labelBreaking = true,
  amendments?: string[]
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
    mattermostSystem: labelBreaking
      ? MATTERMOST_COMMITS_PROMPT_LABELED
      : MATTERMOST_COMMITS_PROMPT_FLAT,
    mattermostUser: `Summarize commits between xrpld ${baseTag} and ${tag}:\n\n${commitList}`,
    mattermostHeader: `**Preliminary changes since \`${baseTag}\`** _(no GitHub Release published yet — summarized from raw commits)_:`,
    twitterUser: `Version: XRP Ledger version ${tag} (no GitHub Release published; tagged from develop/release branch)\n${amendmentsBlock(amendments)}Commits since ${baseTag}:\n${commitList}`,
    includeTwitter,
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
  includeTwitter: boolean
  source: string
}

/**
 * Generates the Mattermost summary, and the tweet only when includeTwitter
 * is set (the final binary-poll path). Both AI calls fire in parallel for
 * low latency. Any failure throws — a partial post would be worse than none.
 */
async function runBothPrompts(opts: RunBothOpts): Promise<Summaries> {
  const client = createAnthropicClient(opts.apiKey)

  const mattermostCall = client.messages
    .create({
      model: MODEL,
      max_tokens: MAX_TOKENS_MATTERMOST,
      system: opts.mattermostSystem,
      messages: [{ role: 'user', content: opts.mattermostUser }],
    })
    .then((r) => extractText(r, 'mattermost'))

  const twitterCall = opts.includeTwitter
    ? client.messages
        .create({
          model: MODEL,
          max_tokens: MAX_TOKENS_TWITTER,
          system: TWITTER_PROMPT,
          messages: [{ role: 'user', content: opts.twitterUser }],
        })
        .then((r) => extractText(r, 'twitter'))
    : Promise.resolve('')

  const [mmText, twText] = await Promise.all([mattermostCall, twitterCall])

  if (opts.includeTwitter && twText.length > TWITTER_MAX_CHARS) {
    throw new Error(
      `AI tweet exceeded ${TWITTER_MAX_CHARS} chars (${twText.length}) — refusing to post`
    )
  }

  opts.logger?.info('Generated AI summaries', {
    tag: opts.tag,
    source: opts.source,
    mattermost_chars: mmText.length,
    twitter_chars: twText.length,
    tweeted: opts.includeTwitter,
  })

  return {
    mattermost: `${opts.mattermostHeader}\n${mmText}`,
    twitter: twText,
  }
}

export function extractText(
  response: Anthropic.Message,
  channel: string
): string {
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
