import axios from 'axios'

const GITHUB_API = 'https://api.github.com'

export async function fetchFileContent(
  owner: string,
  repo: string,
  filePath: string,
  ref: string,
  token?: string
): Promise<string> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.raw+json',
    'User-Agent': 'xrplf-release-notifier',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  const response = await axios.get<string>(url, { headers })
  return response.data
}

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

export async function compareCommits(
  owner: string,
  repo: string,
  base: string,
  head: string,
  token?: string
): Promise<CommitSummary[] | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  const headers = buildHeaders('application/vnd.github+json', token)
  try {
    const res = await axios.get<{
      commits: {
        sha: string
        commit: { message: string; author?: { name?: string } }
      }[]
    }>(url, { headers })
    return res.data.commits.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name ?? 'unknown',
    }))
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return null
    }
    throw err
  }
}

function buildHeaders(accept: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'User-Agent': 'xrplf-release-notifier',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}
