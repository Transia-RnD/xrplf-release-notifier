export enum VersionType {
  BETA = 'beta',
  RC = 'rc',
  FINAL = 'final',
}

export interface VersionInfo {
  raw: string
  major: number
  minor: number
  patch: number
  type: VersionType
  branch: string
  commitSha: string
  commitUrl: string
}

export enum NotificationSource {
  WEBHOOK = 'webhook',
  BINARY_POLL = 'binary_poll',
  TAG = 'tag',
  RELEASE = 'release',
}
