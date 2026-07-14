import type { Logger } from 'winston'
import { listPullRequests } from '../github/client'
import { getErrorMessage } from '../utils/error'
import type { Feature } from './reference'
import type { FeatureVerdict, SdkInventory } from './runSdkAgent'

/**
 * Deterministically turns the agent's typed-transaction INVENTORY into a verdict
 * per checklist feature. This is where parity is decided — not in the LLM — so
 * the supported/declared-only/missing call is consistent:
 *   - supported     = a TRANSACTION wire-name in the SDK's typed inventory
 *   - declared-only = not typed, but present in definitions.json (serializes)
 *   - missing       = not typed and not in definitions.json
 * Only transactions can be `supported`. Fields (and any ledger types that slip
 * into a checklist) have no typed-builder layer we assess, so they top out at
 * declared-only — we assert serialization, not typed support, for those.
 */
export function computeVerdicts(
  checklist: Feature[],
  inventory: SdkInventory,
  definitionsContent: string | null
): FeatureVerdict[] {
  const tx = new Set(inventory.typedTransactionTypes)
  return checklist.map((f): FeatureVerdict => {
    const declared = definitionsContent
      ? definitionsContent.includes(`"${f.name}"`)
      : false
    const typed = f.kind === 'transactionType' && tx.has(f.name)
    const level2: FeatureVerdict['level2'] = typed
      ? 'supported'
      : declared
        ? 'declared-only'
        : 'missing'
    return {
      name: f.name,
      kind: f.kind,
      level1Serialization: declared,
      level2,
      evidence: [],
    }
  })
}

// Trailing transaction/action verbs — stripped to get a feature "stem" so a PR
// titled "add PermissionedDomains" matches feature "PermissionedDomainSet".
const ACTION_SUFFIX =
  /(Create|Destroy|Delete|Set|Authorize|Cancel|Finish|Claim|Modify|Accept|Mint|Burn|Bid|Vote|Deposit|Withdraw|Pay|Manage|Cover|Clawback)$/

function stem(name: string): string {
  return name.replace(ACTION_SUFFIX, '')
}

function bestPr(
  name: string,
  prs: { number: number; title: string; body: string; branch: string }[]
): { number: number; score: number } | null {
  const lname = name.toLowerCase()
  const lstem = stem(name).toLowerCase()
  let best: { number: number; score: number } | null = null
  for (const pr of prs) {
    const text = `${pr.title} ${pr.body}`.toLowerCase()
    const branch = pr.branch.toLowerCase()
    let score = 0
    if (text.includes(lname)) score = 5
    else if (lstem.length >= 4 && text.includes(lstem)) score = 3
    else if (lstem.length >= 4 && branch.includes(lstem)) score = 2
    if (score > (best?.score ?? 0)) best = { number: pr.number, score }
  }
  return best
}

/**
 * Annotate each not-yet-supported feature with the best matching open PR, so the
 * report can say "missing, but PR #N in progress". One PR-list call per SDK;
 * matches by exact wire-name, then a verb-stripped stem, in title/body/branch.
 */
export async function attachInProgressPRs(
  repo: string,
  features: FeatureVerdict[],
  githubToken: string | undefined,
  logger?: Logger
): Promise<void> {
  const gaps = features.filter((f) => f.level2 !== 'supported')
  if (gaps.length === 0) return
  let prs
  try {
    prs = await listPullRequests(repo, githubToken)
  } catch (err: unknown) {
    logger?.warn('Could not list PRs for in-progress detection', {
      repo,
      error: getErrorMessage(err),
    })
    return
  }
  for (const f of gaps) {
    const match = bestPr(f.name, prs)
    if (match) f.inProgressPR = match
  }
}
