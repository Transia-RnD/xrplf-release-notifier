import axios from 'axios'
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { fetchLatestBinaryVersions } from '../src/poller/binary-checker'
import { fetchFileContent } from '../src/github/client'
import { parseVersionFromContent, classifyVersion } from '../src/version/parser'
import { formatMessages } from '../src/notifications/formatter'
import { NotificationSource, VersionInfo } from '../src/version/types'

const OWNER = 'XRPLF'
const REPO = 'rippled'
const BUILD_INFO_PATH = 'src/libxrpl/protocol/BuildInfo.cpp'

interface BranchSnapshot {
  branch: string
  version: string | null
  classified?: ReturnType<typeof classifyVersion>
  commitSha?: string
  preview?: ReturnType<typeof formatMessages>
  error?: string
}

async function fetchBranchHead(branch: string, token?: string): Promise<string | undefined> {
  try {
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/branches/${branch}`
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'xrplf-release-notifier-script',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await axios.get<{ commit: { sha: string } }>(url, { headers })
    return res.data.commit.sha
  } catch {
    return undefined
  }
}

async function fetchBranchSnapshot(branch: string, token?: string): Promise<BranchSnapshot> {
  try {
    const [content, sha] = await Promise.all([
      fetchFileContent(OWNER, REPO, BUILD_INFO_PATH, branch, token),
      fetchBranchHead(branch, token),
    ])
    const version = parseVersionFromContent(content)
    if (!version) return { branch, version: null, error: 'version string not found' }
    const classified = classifyVersion(version)
    const versionInfo: VersionInfo = {
      ...classified,
      branch,
      commitSha: sha ?? '',
      commitUrl: sha ? `https://github.com/${OWNER}/${REPO}/commit/${sha}` : '',
    }
    return {
      branch,
      version,
      classified,
      commitSha: sha,
      preview: formatMessages(versionInfo, NotificationSource.WEBHOOK),
    }
  } catch (err) {
    return { branch, version: null, error: err instanceof Error ? err.message : String(err) }
  }
}

async function listReleaseBranches(token?: string): Promise<string[]> {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/branches?per_page=100`
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'xrplf-release-notifier-script',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await axios.get<Array<{ name: string }>>(url, { headers })
  return res.data
    .map((b) => b.name)
    .filter((n) => n === 'develop' || n.startsWith('release'))
}

function binaryPreview(version: string) {
  const versionInfo: VersionInfo = {
    ...classifyVersion(version),
    branch: 'release',
    commitSha: '',
    commitUrl: '',
  }
  return formatMessages(versionInfo, NotificationSource.BINARY_POLL)
}

function printSection(title: string, body: string) {
  console.log(`\n=== ${title} ===`)
  console.log(body)
}

async function main() {
  const token = process.env.GITHUB_TOKEN
  const outPath = resolve(process.argv[2] ?? 'release-status.json')

  const [binaries, branches] = await Promise.all([
    fetchLatestBinaryVersions(),
    listReleaseBranches(token),
  ])

  const branchResults = await Promise.all(branches.map((b) => fetchBranchSnapshot(b, token)))

  const binaryPreviews = {
    deb: binaries.deb ? binaryPreview(binaries.deb) : null,
    rpm: binaries.rpm ? binaryPreview(binaries.rpm) : null,
  }

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    binaries,
    binaryPreviews,
    branches: branchResults,
  }

  writeFileSync(outPath, JSON.stringify(snapshot, null, 2))

  console.log(`Wrote ${outPath}`)
  console.log(`\nBinaries on repos.ripple.com → deb=${binaries.deb} rpm=${binaries.rpm}`)
  for (const b of branchResults) {
    if (b.error) {
      console.log(`\n[${b.branch}] error: ${b.error}`)
      continue
    }
    console.log(`\n--- branch: ${b.branch} (${b.version}) ---`)
    if (b.preview) {
      printSection('Mattermost', b.preview.mattermost)
      printSection('Twitter', b.preview.twitter)
    }
  }
  if (binaryPreviews.deb) {
    console.log(`\n--- binary poll: deb=${binaries.deb} ---`)
    printSection('Mattermost', binaryPreviews.deb.mattermost)
    printSection('Twitter', binaryPreviews.deb.twitter)
  }
}

main().catch((err) => {
  console.error('release-status failed', err)
  process.exit(1)
})
