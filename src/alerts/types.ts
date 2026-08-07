/** Shared alert vocabulary. The catalog and the routing layer both build on this. */

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL'

export const SEVERITY_RANK: Record<Severity, number> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
}

/** Networks the observatory watches. Each runs its own monitor deployment. */
export type NetworkId = 'mainnet' | 'alphanet'

export const NETWORK_IDS: NetworkId[] = ['mainnet', 'alphanet']

/**
 * Subscription groups. `releases` and `parity` describe the software and carry
 * no network; the rest describe a running network and always carry one.
 */
export type Topic =
  | 'network'
  | 'security'
  | 'unl'
  | 'infra'
  | 'releases'
  | 'parity'

export const TOPICS: Topic[] = [
  'network',
  'security',
  'unl',
  'infra',
  'releases',
  'parity',
]

/** Topics that describe a network, and so require one on every event. */
export const NETWORK_SCOPED_TOPICS: ReadonlySet<Topic> = new Set<Topic>([
  'network',
  'security',
  'unl',
  'infra',
])

export function isNetworkScoped(topic: Topic): boolean {
  return NETWORK_SCOPED_TOPICS.has(topic)
}
