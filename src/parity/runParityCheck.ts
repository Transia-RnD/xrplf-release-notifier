import type { Logger } from 'winston'
import type { Storage } from '@google-cloud/storage'
import type { AppConfig } from '../config'
import type { VersionInfo } from '../version/types'
import { VersionType } from '../version/types'
import { finalTagExists } from '../version/predecessor'
import { postToMattermost } from '../notifications/mattermost'
import type { MattermostPayload } from '../notifications/mattermost'
import { mirrorToSlack } from '../notifications/slack'
import { loadParityConfig, loadXlsMap } from './sdks'
import type { SdkTarget } from './sdks'
import { buildReference, fullTypeChecklist, deltaChecklist } from './reference'
import type { Reference, Feature } from './reference'
import { runSdkAgent } from './runSdkAgent'
import type { SdkParityResult } from './runSdkAgent'
import { computeVerdicts, attachInProgressPRs } from './match'
import { getErrorMessage } from '../utils/error'
import { resolveRefSha, getFileAtRef } from '../github/client'
import {
  loadLocationsCache,
  saveLocationsCache,
  getCachedLocations,
  isCacheWarm,
  setCachedLocations,
} from './cache'
import type { LocationsCache } from './cache'
import { formatParityReport } from './report'
import type { SdkReport } from './report'
import { runDocsCheck } from './runDocsCheck'
import { runXlsCheck } from './runXlsCheck'

export interface ParityDeps {
  config: AppConfig
  storage: Storage
  logger: Logger
}

/**
 * Guards against double-processing the same version within a single process
 * lifetime (the tag-push and release-publish webhooks can both fire for one
 * version — see webhook/handler.ts).
 */
const processedVersions = new Set<string>()

/**
 * Runs the SDK feature-parity check for a rippled release and posts a report
 * to Mattermost. Triggered asynchronously off the release event (see the
 * /parity endpoint) since it makes many GitHub calls and runs an agent per SDK
 * — far past GitHub's 10s webhook-delivery limit. Never throws to the caller:
 * a parity failure must not affect the primary release notification.
 */
export interface RunParityOptions {
  /**
   * Override predecessor resolution. Useful for manual runs of a beta against
   * the last final (e.g. "what's new in 3.2.0" = 3.2.0-b7 vs 3.1.3) instead of
   * the auto-resolved closest predecessor (3.2.0-b6).
   */
  predecessorTag?: string
  /**
   * 'delta' (default, the release path): check only features new vs the
   * predecessor. 'full' (the occasional backlog sweep): check every transaction
   * + ledger type the ref defines, so an SDK lagging on an OLD feature still
   * shows up. No predecessor is used in full mode.
   */
  mode?: 'delta' | 'full'
  /** Build the report but skip the Mattermost post (verification). */
  dryRun?: boolean
  /** Skip the per-SDK agent scans and run only the docs-parity check. */
  docsOnly?: boolean
  /** Skip the SDK and docs checks and run only the XLS spec-parity check. */
  xlsOnly?: boolean
}

export interface ParityPayloads {
  sdk?: MattermostPayload
  docs?: MattermostPayload
  xls?: MattermostPayload
}

export async function runParityCheck(
  version: VersionInfo,
  deps: ParityDeps,
  opts: RunParityOptions = {}
): Promise<ParityPayloads | undefined> {
  const { config, storage, logger } = deps
  const tag = version.raw

  // The double-run guard is for the webhook path (tag + release both fire).
  // Dry runs are manual/idempotent, so don't let it block a repeat.
  if (!opts.dryRun && processedVersions.has(tag)) {
    logger.info('Parity check already ran for version this lifetime', { tag })
    return undefined
  }
  if (!opts.dryRun) processedVersions.add(tag)

  const mode = opts.mode ?? 'delta'

  try {
    const parityConfig = loadParityConfig()

    // Tag-burst debounce: the team builds RCs privately and syncs the whole
    // train (rc1..rcN + final) to the public repo at cycle end. Each tag fires
    // this check, and every prerelease would post the same cumulative report —
    // once the line's FINAL exists, its report supersedes them all, so skip.
    const isPrerelease =
      version.type === VersionType.BETA || version.type === VersionType.RC
    if (isPrerelease && mode === 'delta') {
      const [owner, name] = parityConfig.rippled.repo.split('/')
      if (await finalTagExists(owner, name, tag, config.githubToken)) {
        logger.info(
          'Skipping prerelease parity — final for this line already tagged',
          { tag }
        )
        return undefined
      }
    }

    const reference = await buildReference({
      repo: parityConfig.rippled.repo,
      tag,
      // Full mode is a backlog sweep — no predecessor, no delta.
      predecessorTag: mode === 'full' ? null : opts.predecessorTag,
      githubToken: config.githubToken,
      logger,
    })

    const checklist =
      mode === 'full' ? fullTypeChecklist(reference) : deltaChecklist(reference)

    logger.info('Built parity reference', {
      tag,
      mode,
      predecessor: reference.predecessorTag,
      checklist: checklist.length,
      addedAmendments: reference.addedAmendments,
    })

    const payloads: ParityPayloads = {}

    if (!opts.docsOnly && !opts.xlsOnly) {
      const sdks: SdkReport[] = []
      const cache = await loadLocationsCache(storage)

      if (checklist.length > 0) {
        // Sequential, NOT parallel: each agent reads large definitions.json files,
        // and running all SDKs at once bursts past the Anthropic per-minute
        // input-token rate limit (5 concurrent Sonnet agents 429'd in practice).
        for (const sdk of parityConfig.sdks) {
          sdks.push(
            await auditSdk(sdk, reference, checklist, mode, cache, deps)
          )
        }

        // Persist whatever locations the agents resolved this run (best-effort).
        try {
          await saveLocationsCache(storage, cache)
        } catch (err: unknown) {
          logger.warn('Failed to persist parity locations cache', {
            error: getErrorMessage(err),
          })
        }
      }

      payloads.sdk = formatParityReport({
        versionType: version.type,
        reference,
        sdks,
        mode,
      })

      const behind = sdks.filter(
        (s) =>
          s.error !== undefined ||
          (s.result?.features.some((f) => f.level2 !== 'supported') ?? false)
      ).length

      if (opts.dryRun) {
        logger.info('DRY RUN — report built, not posted', {
          tag,
          mode,
          sdks: sdks.length,
          behind,
        })
      } else {
        await postToMattermost(config.mattermostWebhookUrl, payloads.sdk)
        await mirrorToSlack(config.slackWebhookUrl, payloads.sdk, logger)
        logger.info('Parity report posted', { tag, sdks: sdks.length, behind })
      }
    }

    // Docs parity runs even when the SDK checklist is empty: its delta also
    // covers ledger entries and amendments, which the SDK check excludes.
    // Isolated so a docs failure (or a failed post) can't sink the SDK report.
    if (!opts.xlsOnly) {
      try {
        const docsPayload = await runDocsCheck({
          reference,
          versionType: version.type,
          mode,
          docs: parityConfig.docs,
          githubToken: config.githubToken,
          logger,
        })
        if (docsPayload) {
          payloads.docs = docsPayload
          if (!opts.dryRun) {
            await postToMattermost(config.mattermostWebhookUrl, docsPayload)
            await mirrorToSlack(config.slackWebhookUrl, docsPayload, logger)
            logger.info('Docs parity report posted', { tag, mode })
          }
        }
      } catch (err: unknown) {
        logger.error('Docs parity step failed', {
          tag,
          error: getErrorMessage(err),
        })
      }
    }

    // XLS parity — the third leg: does the code still match the specification
    // each amendment was approved under? Isolated for the same reason.
    if (!opts.docsOnly) {
      try {
        const xlsPayload = await runXlsCheck({
          reference,
          versionType: version.type,
          mode,
          xls: parityConfig.xls,
          docs: parityConfig.docs,
          xlsMap: loadXlsMap(),
          githubToken: config.githubToken,
          logger,
        })
        if (xlsPayload) {
          payloads.xls = xlsPayload
          if (!opts.dryRun) {
            await postToMattermost(config.mattermostWebhookUrl, xlsPayload)
            await mirrorToSlack(config.slackWebhookUrl, xlsPayload, logger)
            logger.info('XLS parity report posted', { tag, mode })
          }
        }
      } catch (err: unknown) {
        logger.error('XLS parity step failed', {
          tag,
          error: getErrorMessage(err),
        })
      }
    }

    return payloads
  } catch (err: unknown) {
    logger.error('Parity check failed', {
      tag,
      error: getErrorMessage(err),
    })
    return undefined
  }
}

/**
 * Audit one SDK: one agent call to inventory its typed models, then the
 * supported/declared-only/missing verdict for every checklist feature is
 * computed DETERMINISTICALLY from that inventory + definitions.json. The agent
 * never decides parity, so it can't credit a same-named transaction as
 * ledger-object support, and there's no cross-batch inconsistency. Works the
 * same for delta (small checklist) and full (all 104 types).
 */
async function auditSdk(
  sdk: SdkTarget,
  reference: Reference,
  checklist: Feature[],
  mode: 'delta' | 'full',
  cache: LocationsCache,
  deps: ParityDeps
): Promise<SdkReport> {
  const { config, logger } = deps
  try {
    const sha = await resolveRefSha(sdk.repo, sdk.ref, config.githubToken)
    if (!isCacheWarm(cache, sdk.repo, sha)) {
      logger.info('Parity cache cold/drifted — agent will re-resolve', {
        repo: sdk.repo,
        sha,
      })
    }

    // 1. Agent enumerates the SDK's typed-model inventory (one call).
    const inventory = await runSdkAgent({
      apiKey: config.anthropicApiKey,
      repo: sdk.repo,
      ref: sdk.ref,
      sdkName: sdk.name,
      hints: getCachedLocations(cache, sdk.repo),
      githubToken: config.githubToken,
      logger,
    })

    // 2. Fetch definitions.json once (Level-1 source for both types and fields).
    const defPath = inventory.resolvedLocations.definitions
    const definitionsContent = defPath
      ? await getFileAtRef(sdk.repo, defPath, sdk.ref, config.githubToken)
      : null

    // 3. Deterministic verdicts + in-progress-PR annotation.
    const features = computeVerdicts(checklist, inventory, definitionsContent)
    await attachInProgressPRs(
      sdk.repo,
      features.filter((f) => f.level2 !== 'supported'),
      config.githubToken,
      logger
    )

    const result: SdkParityResult = {
      repo: sdk.repo,
      ref: sdk.ref,
      resolvedLocations: inventory.resolvedLocations,
      runtimeDefinitions: inventory.runtimeDefinitions,
      features,
      notes: inventory.notes,
    }
    setCachedLocations(
      cache,
      sdk.repo,
      sha ?? 'unknown',
      inventory.resolvedLocations
    )

    // 4. Full mode: deterministic field-coverage count from the same file.
    let fieldsLevel1: SdkReport['fieldsLevel1']
    if (mode === 'full') {
      const missing = definitionsContent
        ? reference.full.fields.filter(
            (f) => !definitionsContent.includes(`"${f}"`)
          )
        : reference.full.fields
      fieldsLevel1 = {
        present: reference.full.fields.length - missing.length,
        total: reference.full.fields.length,
        missing,
      }
    }

    return { name: sdk.name, repo: sdk.repo, result, fieldsLevel1 }
  } catch (err: unknown) {
    const message = getErrorMessage(err)
    logger.error('Parity agent failed for SDK', {
      repo: sdk.repo,
      error: message,
    })
    return { name: sdk.name, repo: sdk.repo, error: message }
  }
}
