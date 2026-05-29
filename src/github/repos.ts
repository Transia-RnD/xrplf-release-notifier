export interface RepoConfig {
  owner: string
  name: string
  visibility: 'public' | 'private'
}

export const REPOS: RepoConfig[] = [
  { owner: 'XRPLF', name: 'rippled', visibility: 'public' },
  { owner: 'XRPLF', name: 'xrpld-private', visibility: 'private' },
]

function requireRepo(visibility: 'public' | 'private'): RepoConfig {
  const repo = REPOS.find((r) => r.visibility === visibility)
  if (!repo) {
    throw new Error(`No ${visibility} repo configured in REPOS`)
  }
  return repo
}

export const PUBLIC_REPO = requireRepo('public')
export const PRIVATE_REPO = requireRepo('private')

export function findRepoByFullName(fullName: string): RepoConfig | undefined {
  return REPOS.find((r) => `${r.owner}/${r.name}` === fullName)
}

export function repoFullName(repo: RepoConfig): string {
  return `${repo.owner}/${repo.name}`
}
