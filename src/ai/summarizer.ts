import Anthropic from '@anthropic-ai/sdk'
import { Logger } from 'winston'
import {
  fetchReleaseBody,
  listVersionTags,
  compareCommits,
  CommitSummary,
} from '../github/client'
import { compareVersions } from '../poller/binary-checker'

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS = 1024

const SYSTEM_PROMPT = `You summarize rippled release notes for XRPL node operators.

Output 5-10 short bullet points in markdown (using • not -). Rules:
- Lead with SECURITY fixes and BREAKING / behavior changes.
- Then list significant new features.
- Then notable bug fixes.
- Skip routine docs/CI/test-only changes unless that's all that's in the release.
- Each bullet ≤ 120 chars. No preamble, no headings, no closing remarks — just the bullets.
- If you genuinely can't find anything substantive (release body is empty or boilerplate), output the single bullet: "• No notable changes."`

const COMMITS_SYSTEM_PROMPT = `You summarize a list of git commits between two rippled tags for XRPL node operators.

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

export interface SummarizeOptions {
  owner: string
  repo: string
  tag: string
  apiKey?: string
  githubToken?: string
  logger?: Logger
}

export async function summarizeReleaseByTag(
  opts: SummarizeOptions
): Promise<string | null> {
  if (!opts.apiKey) {
    opts.logger?.info('Skipping AI summary — no ANTHROPIC_API_KEY configured')
    return null
  }

  // Try curated GitHub Release body first
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

  if (body && body.trim().length >= 20) {
    return summarizeBody(body, opts.tag, opts.apiKey, opts.logger)
  }

  // Fallback: diff against the prior version tag, summarize commits
  opts.logger?.info('No Release body found, falling back to commit-compare', {
    tag: opts.tag,
  })
  return summarizeCommitsSinceLast(opts)
}

async function summarizeCommitsSinceLast(
  opts: SummarizeOptions
): Promise<string | null> {
  let tags: string[]
  try {
    tags = await listVersionTags(opts.owner, opts.repo, opts.githubToken)
  } catch (err) {
    opts.logger?.warn('Failed to list tags for commit-compare', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  const target = opts.tag.replace(/^v/, '')
  const normalized = tags
    .map((t) => ({ raw: t, normalized: t.replace(/^v/, '') }))
    .filter((t) => t.normalized !== target)

  // Anything semantically less than the target
  const predecessors = normalized
    .filter((t) => compareVersions(t.normalized, target) < 0)
    .sort((a, b) => compareVersions(a.normalized, b.normalized))

  const prior = predecessors.at(-1)
  if (!prior) {
    opts.logger?.info('No predecessor tag found for commit-compare', {
      tag: opts.tag,
    })
    return null
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
    return null
  }

  if (!commits || commits.length === 0) {
    opts.logger?.info('No commits between predecessor and target', {
      base: prior.raw,
      head: opts.tag,
    })
    return null
  }

  return summarizeCommits(commits, opts.tag, prior.raw, opts.apiKey!, opts.logger)
}

const TRIVIAL_COMMIT = /^(merge |bump version|version bump|set version|clang-format|format:)/i

async function summarizeCommits(
  commits: CommitSummary[],
  tag: string,
  baseTag: string,
  apiKey: string,
  logger?: Logger
): Promise<string | null> {
  // Filter trivial commits, keep first line of each message, cap at 80
  const filtered = commits
    .map((c) => ({ ...c, message: c.message.split('\n')[0].trim() }))
    .filter((c) => c.message && !TRIVIAL_COMMIT.test(c.message))
    .slice(0, 80)

  if (filtered.length === 0) {
    return `• No notable changes since ${baseTag}.`
  }

  const commitList = filtered
    .map((c) => `- ${c.message} (${c.sha.slice(0, 7)}, ${c.author})`)
    .join('\n')

  const client = new Anthropic({ apiKey })
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: COMMITS_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Summarize commits between rippled ${baseTag} and ${tag}:\n\n${commitList}`,
        },
      ],
    })
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) return null
    logger?.info('Generated commit-compare summary', {
      tag,
      base: baseTag,
      commits: filtered.length,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    })
    return `_Preliminary signal from commits since ${baseTag} (no GitHub Release published yet):_\n${text}`
  } catch (err) {
    logger?.warn('Claude commit summarization failed', {
      tag,
      base: baseTag,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export async function summarizeBody(
  body: string,
  tag: string,
  apiKey: string,
  logger?: Logger
): Promise<string | null> {
  const client = new Anthropic({ apiKey })

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Summarize rippled ${tag} release notes:\n\n${body}`,
        },
      ],
    })

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()

    if (!text) return null
    logger?.info('Generated release summary', {
      tag,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    })
    return text
  } catch (err) {
    logger?.warn('Claude summarization failed', {
      tag,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
