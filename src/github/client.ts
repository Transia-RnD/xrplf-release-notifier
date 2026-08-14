import axios from 'axios'

const GITHUB_API = 'https://api.github.com'

export async function fetchReleaseBody(
  owner: string,
  repo: string,
  tag: string,
  token?: string
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`
  const headers = buildHeaders('application/vnd.github+json', token)
  try {
    const response = await axios.get<{ body?: string | null }>(url, { headers })
    return response.data.body ?? null
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return null
    }
    throw err
  }
}

const VERSION_TAG = /^v?(\d+)\.(\d+)\.(\d+)(?:-(b|rc)(\d+))?$/

export async function listVersionTags(
  owner: string,
  repo: string,
  token?: string
): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/tags?per_page=100`
  const headers = buildHeaders('application/vnd.github+json', token)
  const res = await axios.get<{ name: string }[]>(url, { headers })
  return res.data.map((t) => t.name).filter((n) => VERSION_TAG.test(n))
}

export interface CommitSummary {
  sha: string
  message: string
  author: string
}

/** A file changed between two refs, as returned by the compare endpoint. */
export interface DiffFile {
  filename: string
  status: string
  additions: number
  deletions: number
  /** Unified diff hunk. Absent for binary files and some very large diffs. */
  patch?: string
}

export interface CompareResult {
  commits: CommitSummary[]
  files: DiffFile[]
}

/**
 * Full compare between two refs: commits AND changed files (with patches).
 * The GitHub compare endpoint returns both in one call, so this is the single
 * source for both the commit-message summary and the diff-based analysis.
 * Returns null on 404 (unknown ref), matching compareCommits' contract.
 */
export async function fetchCompare(
  owner: string,
  repo: string,
  base: string,
  head: string,
  token?: string
): Promise<CompareResult | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  const headers = buildHeaders('application/vnd.github+json', token)
  try {
    const res = await axios.get<{
      commits: {
        sha: string
        commit: { message: string; author?: { name?: string } }
      }[]
      files?: {
        filename: string
        status: string
        additions?: number
        deletions?: number
        patch?: string
      }[]
    }>(url, { headers })
    return {
      commits: res.data.commits.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        author: c.commit.author?.name ?? 'unknown',
      })),
      files: (res.data.files ?? []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch: f.patch,
      })),
    }
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return null
    }
    throw err
  }
}

export async function compareCommits(
  owner: string,
  repo: string,
  base: string,
  head: string,
  token?: string
): Promise<CommitSummary[] | null> {
  const result = await fetchCompare(owner, repo, base, head, token)
  return result?.commits ?? null
}

function buildHeaders(accept: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'User-Agent': 'xrplf-release-notifier',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

// ---------------------------------------------------------------------------
// Repo-introspection helpers (used by the SDK parity checker). These work
// across arbitrary repos, so they key on a `repo` full-name ("owner/name")
// rather than the (owner, repo) pair the release-specific helpers above use.
// Same axios + buildHeaders + token path — no second GitHub client.
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string
  path: string
  /** 'file' | 'dir' | 'symlink' | 'submodule' (GitHub's contents API). */
  type: string
}

export interface CodeHit {
  path: string
}

export interface PullRequest {
  number: number
  title: string
  body: string
  branch: string
  url: string
}

export interface PrFile {
  path: string
  status: string
  patch?: string
}

/** Encode a repo path for a URL while preserving the slashes between segments. */
function encodePath(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/**
 * Fetch a single file's raw text at a given ref. Returns null on 404 (path
 * doesn't exist at that ref — e.g. a moved/renamed file), so callers can treat
 * a stale cached path as "re-discover" rather than an error.
 */
export async function getFileAtRef(
  repo: string,
  path: string,
  ref: string,
  token?: string
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
  try {
    const res = await axios.get<string>(url, {
      headers: buildHeaders('application/vnd.github.raw+json', token),
      // raw media type returns the file body as text, not JSON
      transformResponse: (d: unknown) => d,
    })
    return typeof res.data === 'string' ? res.data : String(res.data)
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null
    throw err
  }
}

/** List a directory's immediate entries at a ref. Null on 404. */
export async function listDir(
  repo: string,
  path: string,
  ref: string,
  token?: string
): Promise<DirEntry[] | null> {
  const cleanPath = path.replace(/^\/+|\/+$/g, '')
  const url = `${GITHUB_API}/repos/${repo}/contents/${encodePath(cleanPath)}?ref=${encodeURIComponent(ref)}`
  try {
    const res = await axios.get<DirEntry[] | DirEntry>(url, {
      headers: buildHeaders('application/vnd.github+json', token),
    })
    return Array.isArray(res.data) ? res.data : [res.data]
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null
    throw err
  }
}

/**
 * Search code within a repo via the GitHub code-search API (default branch
 * only; ~30 req/min authenticated). Returns matching file paths. Swallows
 * 4xx/rate-limit errors to an empty result so the agent falls back to listDir
 * navigation rather than aborting the whole scan.
 */
export async function searchCode(
  repo: string,
  query: string,
  token?: string
): Promise<CodeHit[]> {
  const q = `${query} repo:${repo}`
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=50`
  try {
    const res = await axios.get<{ items: { path: string }[] }>(url, {
      headers: buildHeaders('application/vnd.github.text-match+json', token),
    })
    return (res.data.items ?? []).map((i) => ({ path: i.path }))
  } catch (err) {
    if (axios.isAxiosError(err)) return []
    throw err
  }
}

/**
 * Every file path in a repo at a ref, in ONE call (git trees API, recursive).
 * Used to locate sources whose directory layout moves between releases — the
 * transactors, for instance, live under `src/libxrpl/tx/transactors/` today and
 * `src/xrpld/app/tx/detail/` in older refs. Returns null when GitHub truncates
 * the response, since a partial tree would read as "file absent".
 */
export async function listTree(
  repo: string,
  ref: string,
  token?: string
): Promise<string[] | null> {
  const url = `${GITHUB_API}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
  try {
    const res = await axios.get<{
      tree: { path: string; type: string }[]
      truncated: boolean
    }>(url, { headers: buildHeaders('application/vnd.github+json', token) })
    if (res.data.truncated) return null
    return res.data.tree.filter((t) => t.type === 'blob').map((t) => t.path)
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null
    throw err
  }
}

/** ISO date of the most recent commit touching `path`. Null if none/404. */
export async function lastCommitDate(
  repo: string,
  path: string,
  ref: string,
  token?: string
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=1`
  try {
    const res = await axios.get<
      { commit: { committer?: { date?: string } } }[]
    >(url, { headers: buildHeaders('application/vnd.github+json', token) })
    return res.data[0]?.commit?.committer?.date ?? null
  } catch (err) {
    if (axios.isAxiosError(err)) return null
    throw err
  }
}

/** List open PRs for a repo (first 100). */
export async function listPullRequests(
  repo: string,
  token?: string
): Promise<PullRequest[]> {
  const url = `${GITHUB_API}/repos/${repo}/pulls?state=open&per_page=100`
  const res = await axios.get<
    {
      number: number
      title: string
      body: string | null
      head: { ref: string }
      html_url: string
    }[]
  >(url, { headers: buildHeaders('application/vnd.github+json', token) })
  return res.data.map((p) => ({
    number: p.number,
    title: p.title,
    body: p.body ?? '',
    branch: p.head?.ref ?? '',
    url: p.html_url,
  }))
}

/** Files changed in a PR (first 100), with patches where available. */
export async function fetchPrFiles(
  repo: string,
  number: number,
  token?: string
): Promise<PrFile[]> {
  const url = `${GITHUB_API}/repos/${repo}/pulls/${number}/files?per_page=100`
  const res = await axios.get<
    { filename: string; status: string; patch?: string }[]
  >(url, { headers: buildHeaders('application/vnd.github+json', token) })
  return res.data.map((f) => ({
    path: f.filename,
    status: f.status,
    patch: f.patch,
  }))
}

/** Resolve a ref (branch/tag) to its commit SHA — used as the cache key. */
export async function resolveRefSha(
  repo: string,
  ref: string,
  token?: string
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${repo}/commits/${encodeURIComponent(ref)}`
  try {
    const res = await axios.get<{ sha: string }>(url, {
      headers: buildHeaders('application/vnd.github+json', token),
    })
    return res.data.sha
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null
    throw err
  }
}
