import axios from 'axios'
import type { MattermostPayload } from '../../notifications/mattermost'
import { envelope } from '../../notifications/mattermost'
import type { HandlerContext } from '../handlers'

const GITHUB_API = 'https://api.github.com'
const OWNER = 'XRPLF'
const REPO = 'unl'
/** The list source. A PR touching it is a membership change, not housekeeping. */
const LIST_FILE = 'data/unl-raw.yaml'

/** Age at which a membership request stops being "in review" and starts being ignored. */
const STALE_DAYS = 60

const COLOR_OK = '#4CAF50'
const COLOR_STALE = '#FF9800'

export type PrKind = 'inclusion' | 'removal' | 'other'

export interface ClassifiedPr {
  number: number
  title: string
  url: string
  author: string
  createdAt: string
  kind: PrKind
  ageDays: number
}

interface PullPayload {
  number: number
  title: string
  html_url: string
  created_at: string
  user: { login: string } | null
}

interface FilePayload {
  filename: string
  additions: number
  deletions: number
}

function headers(token?: string): Record<string, string> {
  const base: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'xrplf-release-notifier',
  }
  if (token) base.Authorization = `Bearer ${token}`
  return base
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000)
}

/**
 * A PR is a membership change only if it edits the list source. Direction comes
 * from the line delta on that file — each validator is a two-line YAML entry, so
 * a net gain adds one and a net loss removes one. Titles are not trustworthy
 * here: several merged PRs say "Add ..." while removing an entry.
 */
export function classify(files: FilePayload[]): PrKind {
  const listFile = files.find((f) => f.filename === LIST_FILE)
  if (!listFile) return 'other'
  if (listFile.additions > listFile.deletions) return 'inclusion'
  if (listFile.deletions > listFile.additions) return 'removal'
  return 'other'
}

export async function fetchOpenPrs(
  token: string | undefined,
  now: Date
): Promise<ClassifiedPr[]> {
  const { data: pulls } = await axios.get<PullPayload[]>(
    `${GITHUB_API}/repos/${OWNER}/${REPO}/pulls`,
    { params: { state: 'open', per_page: 100 }, headers: headers(token) }
  )

  const classified: ClassifiedPr[] = []
  for (const pull of pulls) {
    const { data: files } = await axios.get<FilePayload[]>(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/pulls/${pull.number}/files`,
      { params: { per_page: 100 }, headers: headers(token) }
    )
    classified.push({
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      author: pull.user?.login ?? 'unknown',
      createdAt: pull.created_at,
      kind: classify(files),
      ageDays: daysBetween(new Date(pull.created_at), now),
    })
  }

  return classified.sort((a, b) => b.ageDays - a.ageDays)
}

function line(pr: ClassifiedPr): string {
  const flag = pr.ageDays >= STALE_DAYS ? ' ⚠️' : ''
  return `- [#${pr.number}](${pr.url}) ${pr.title} — ${pr.author}, **${pr.ageDays}d**${flag}`
}

export function buildCard(prs: ClassifiedPr[]): MattermostPayload {
  const inclusions = prs.filter((p) => p.kind === 'inclusion')
  const removals = prs.filter((p) => p.kind === 'removal')
  const other = prs.filter((p) => p.kind === 'other')
  const stale = prs.filter(
    (p) => p.kind !== 'other' && p.ageDays >= STALE_DAYS
  ).length

  const sections: string[] = []
  if (inclusions.length) {
    sections.push(
      `**Requesting inclusion (${inclusions.length})**\n${inclusions.map(line).join('\n')}`
    )
  }
  if (removals.length) {
    sections.push(
      `**Requesting removal (${removals.length})**\n${removals.map(line).join('\n')}`
    )
  }
  if (other.length) {
    sections.push(
      `**Not a membership change (${other.length})**\n${other.map(line).join('\n')}`
    )
  }
  if (!sections.length) sections.push('No open pull requests.')

  const title = stale
    ? `dUNL PR queue — ${stale} request(s) waiting over ${STALE_DAYS} days`
    : `dUNL PR queue — ${inclusions.length + removals.length} membership request(s) open`

  return envelope({
    fallback: title,
    color: stale ? COLOR_STALE : COLOR_OK,
    title,
    title_link: `https://github.com/${OWNER}/${REPO}/pulls`,
    text: sections.join('\n\n'),
  })
}

export async function unlPrQueue(context: HandlerContext): Promise<void> {
  const prs = await fetchOpenPrs(context.config.githubToken, context.now)
  await context.post(buildCard(prs), { report: 'unlPrQueue', open: prs.length })
}
