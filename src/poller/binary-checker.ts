import axios from 'axios'

const DEB_URL = 'https://repos.ripple.com/repos/rippled-deb/pool/stable/'
const RPM_URL = 'https://repos.ripple.com/repos/rippled-rpm/stable/'

// The package was rebranded rippled -> xrpld as of 3.2.0 (e.g.
// xrpld_3.2.0-1_amd64.deb). The repo paths are unchanged; match either name so
// the poller keeps detecting both historical and current releases. Anchored on
// the version digit so dbgsym/debuginfo siblings (xrpld-dbgsym_, xrpld-debuginfo-)
// don't match.
const DEB_REGEX =
  /href="(?:rippled|xrpld)_(\d+\.\d+\.\d+(?:-[a-z0-9]+)?)-\d+_amd64\.deb"/g
const RPM_REGEX =
  /href="(?:rippled|xrpld)-(\d+\.\d+\.\d+(?:-[a-z0-9]+)?)-\d+\.\w+\.x86_64\.rpm"/g

export interface PollerState {
  deb: { version: string; detectedAt: string } | null
  rpm: { version: string; detectedAt: string } | null
}

export function parseVersionsFromHtml(html: string, regex: RegExp): string[] {
  const versions: string[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(regex.source, regex.flags)
  while ((match = re.exec(html)) !== null) {
    versions.push(match[1])
  }
  return versions
}

function latestVersion(versions: string[]): string | null {
  if (versions.length === 0) return null
  return versions.sort(compareVersions).at(-1) ?? null
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/-.*$/, '').split('.').map(Number)
  const pb = b.replace(/-.*$/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  const sa = a.includes('-') ? a.split('-')[1] : 'zzz'
  const sb = b.includes('-') ? b.split('-')[1] : 'zzz'
  return sa.localeCompare(sb)
}

export async function fetchLatestBinaryVersions(): Promise<{
  deb: string | null
  rpm: string | null
}> {
  const [debHtml, rpmHtml] = await Promise.all([
    axios.get<string>(DEB_URL).then((r) => r.data),
    axios.get<string>(RPM_URL).then((r) => r.data),
  ])

  return {
    deb: latestVersion(parseVersionsFromHtml(debHtml, DEB_REGEX)),
    rpm: latestVersion(parseVersionsFromHtml(rpmHtml, RPM_REGEX)),
  }
}

export function detectNewVersions(
  current: { deb: string | null; rpm: string | null },
  state: PollerState
): string | null {
  const lastDeb = state.deb?.version
  const lastRpm = state.rpm?.version

  if (current.deb && current.deb !== lastDeb) return current.deb
  if (current.rpm && current.rpm !== lastRpm) return current.rpm
  return null
}
