import axios from 'axios'
import type Anthropic from '@anthropic-ai/sdk'
import { createAnthropicClient } from '../../ai/client'
import { extractText } from '../../ai/summarizer'
import { envelope } from '../../notifications/mattermost'
import type { MattermostPayload } from '../../notifications/mattermost'
import type { HandlerContext } from '../handlers'
import { getErrorMessage } from '../../utils/error'

const GITHUB_API = 'https://api.github.com'

/** Voice matters more than cost here — the draft is meant to be posted nearly as-is. */
export const DRAFT_MODEL = 'claude-sonnet-5'

/**
 * Extended thinking is billed against this budget, so too small a value is spent
 * before any text is produced.
 */
export const DRAFT_MAX_TOKENS = 4000

/** Orgs whose repos count as XRPLF work. */
export const ORGS = ['XRPLF', 'Transia-RnD', 'ripple'] as const

const COLOR_DRAFT = '#2196F3'
const COLOR_QUIET = '#9E9E9E'

/** GitHub caps each search page at 100; two pages is far more than one week. */
const PER_PAGE = 100

export interface PullRequest {
  number: number
  title: string
  url: string
  merged: boolean
}

export interface RepoActivity {
  repo: string
  commits: string[]
  pullRequests: PullRequest[]
}

export interface Window {
  since: Date
  until: Date
}

/** ISO date (YYYY-MM-DD) — the granularity GitHub search qualifiers accept. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** The 7 days ending at `until`. */
export function lastWeek(until: Date): Window {
  const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000)
  return { since, until }
}

function headers(
  token: string | undefined,
  accept: string
): Record<string, string> {
  const h: Record<string, string> = { Accept: accept }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/** `https://api.github.com/repos/XRPLF/rippled` → `XRPLF/rippled`. */
export function repoFromApiUrl(url: string): string {
  return url.replace(`${GITHUB_API}/repos/`, '')
}

interface CommitHit {
  repository?: { full_name?: string }
  commit?: { message?: string }
}

interface IssueHit {
  number?: number
  title?: string
  html_url?: string
  repository_url?: string
  pull_request?: { merged_at?: string | null }
}

/**
 * Merge commit-search and PR-search hits into one entry per repo. Both searches
 * are org-scoped so unrelated personal repos stay out of a work update.
 */
export function groupActivity(
  commits: CommitHit[],
  prs: IssueHit[]
): RepoActivity[] {
  const byRepo = new Map<string, RepoActivity>()
  const entry = (repo: string): RepoActivity => {
    let e = byRepo.get(repo)
    if (!e) {
      e = { repo, commits: [], pullRequests: [] }
      byRepo.set(repo, e)
    }
    return e
  }

  for (const c of commits) {
    const repo = c.repository?.full_name
    const message = c.commit?.message
    if (!repo || !message) continue
    // Commit bodies bury the subject; the subject line is the summary.
    entry(repo).commits.push(message.split('\n')[0].trim())
  }

  for (const p of prs) {
    const repo = p.repository_url ? repoFromApiUrl(p.repository_url) : undefined
    if (!repo || p.number === undefined || !p.title) continue
    entry(repo).pullRequests.push({
      number: p.number,
      title: p.title,
      url: p.html_url ?? '',
      merged: Boolean(p.pull_request?.merged_at),
    })
  }

  // Busiest repo first — that is the week's headline.
  return [...byRepo.values()].sort(
    (a, b) =>
      b.commits.length +
      b.pullRequests.length -
      (a.commits.length + a.pullRequests.length)
  )
}

async function search<T>(
  path: string,
  q: string,
  token: string | undefined,
  accept: string
): Promise<T[]> {
  const res = await axios.get<{ items?: T[] }>(`${GITHUB_API}${path}`, {
    headers: headers(token, accept),
    params: { q, per_page: PER_PAGE },
  })
  return res.data.items ?? []
}

/**
 * Everything `author` pushed or proposed in the window, across ORGS.
 *
 * Only sees work that reached GitHub; local commits and uncommitted work are
 * invisible.
 */
export async function fetchActivity(
  author: string,
  window: Window,
  token?: string
): Promise<RepoActivity[]> {
  const range = `${isoDay(window.since)}..${isoDay(window.until)}`
  const orgs = ORGS.map((o) => `org:${o}`).join(' ')

  const [commits, prs] = await Promise.all([
    search<CommitHit>(
      '/search/commits',
      `author:${author} author-date:${range} ${orgs}`,
      token,
      'application/vnd.github.cloak-preview+json'
    ),
    search<IssueHit>(
      '/search/issues',
      `type:pr author:${author} updated:${range} ${orgs}`,
      token,
      'application/vnd.github+json'
    ),
  ])

  return groupActivity(commits, prs)
}

/** Compact digest for the model — repo, commit subjects, PR titles. */
export function activityDigest(activity: RepoActivity[]): string {
  return activity
    .map((a) => {
      const lines = [
        ...a.commits.map((c) => `  commit: ${c}`),
        ...a.pullRequests.map(
          (p) =>
            `  PR #${p.number} (${p.merged ? 'merged' : 'open'}): ${p.title}`
        ),
      ]
      return `${a.repo}\n${lines.join('\n')}`
    })
    .join('\n\n')
}

const SYSTEM = `You draft Denis Angell's weekly update for the XRPL Foundation team channel.

Match the format he already uses:
- One bullet per workstream, NOT one per commit. Group related commits into the thing they accomplished.
- Each bullet starts with a bold workstream name, then an em-dash, then what happened.
- Lead with the outcome, not the activity. "5M-account baseline at ~197 TPS, node-bound" beats "ran benchmarks".
- Include concrete numbers when the input has them.
- Say "in progress" or "uncommitted" plainly when that is the state.
- Plain, terse, lowercase-ish prose. No marketing adjectives, no "successfully", no "leveraged".
- 5-9 bullets. If the week was thin, write fewer rather than padding.

Prefix each bullet with an audience tag, matching Brett's key:
[partner] usable in partner and board updates
[board] board update only
[internal] team only — security issues, vendor/legal matters, anything unreleased or embargoed

Default to [partner] for ordinary engineering work. Use [internal] for security
fixes, exploits, audits, incidents, and unreleased/private-repo work.

Output only the bullets. No preamble, no closing line.`

/**
 * Draft the update. Null only when there is nothing to draft from; an empty
 * model response throws (via extractText) so the caller falls back to the raw
 * activity list rather than posting a blank card.
 */
export async function draftUpdate(
  activity: RepoActivity[],
  client: Anthropic
): Promise<string | null> {
  if (activity.length === 0) return null

  const response = await client.messages.create({
    model: DRAFT_MODEL,
    max_tokens: DRAFT_MAX_TOKENS,
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Draft the weekly update from this GitHub activity:\n\n${activityDigest(activity)}`,
      },
    ],
  })

  return extractText(response, 'weekly update').trim()
}

export function formatWindow(window: Window): string {
  return `${isoDay(window.since)} to ${isoDay(window.until)}`
}

export function buildCard(
  draft: string | null,
  activity: RepoActivity[],
  window: Window
): MattermostPayload {
  const commits = activity.reduce((n, a) => n + a.commits.length, 0)
  const prs = activity.reduce((n, a) => n + a.pullRequests.length, 0)

  if (!draft) {
    return envelope({
      fallback: `No GitHub activity ${formatWindow(window)}`,
      color: COLOR_QUIET,
      title: `Weekly update draft — ${formatWindow(window)}`,
      text: 'No pushed GitHub activity this week. Anything local still needs writing up by hand.',
    })
  }

  const repos = activity.map((a) => a.repo).join(', ')
  return envelope({
    fallback: `Weekly update draft — ${commits} commits across ${activity.length} repos`,
    color: COLOR_DRAFT,
    title: `Weekly update draft — ${formatWindow(window)}`,
    text:
      `${draft}\n\n` +
      `_Drafted from ${commits} commit(s) and ${prs} PR(s) across ${activity.length} repo(s): ${repos}._\n` +
      `_Pushed work only — local commits and uncommitted work are not visible here. Edit before posting._`,
  })
}

/** Scheduler handler. Posts a draft, never the final update. */
export async function weeklyUpdate(ctx: HandlerContext): Promise<void> {
  const author = process.env.WEEKLY_UPDATE_AUTHOR ?? 'dangell7'
  const window = lastWeek(ctx.now)
  const activity = await fetchActivity(author, window, ctx.config.githubToken)

  let draft: string | null = null
  if (ctx.config.anthropicApiKey && activity.length > 0) {
    try {
      draft = await draftUpdate(
        activity,
        createAnthropicClient(ctx.config.anthropicApiKey)
      )
    } catch (err) {
      // A model outage must not cost the whole update — fall through to the
      // raw activity list, which is still worth posting.
      ctx.logger.warn('Weekly update drafting failed; posting raw activity', {
        error: getErrorMessage(err),
      })
      draft = activityDigest(activity)
    }
  } else if (activity.length > 0) {
    draft = activityDigest(activity)
  }

  await ctx.post(buildCard(draft, activity, window))
}
