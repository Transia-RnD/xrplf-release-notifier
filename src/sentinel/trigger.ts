import axios from 'axios'
import type { Logger } from 'winston'
import type { AppConfig } from '../config'
import { getErrorMessage } from '../utils/error'

export interface SentinelAuditParams {
  owner: string
  repo: string
  /** Git tag / ref to audit, e.g. '3.2.0-rc1'. */
  ref: string
  /** 'beta' | 'rc' | 'final' — drives Sentinel's final-release dedup. */
  versionType: string
}

/**
 * Fire-and-forget trigger of a full-repo security audit on the Sentinel service.
 *
 * Sentinel owns all the policy decisions (is the repo a tracked project, is the
 * release auto-audit opted in, has this tag/version line already been audited),
 * so this just forwards the release facts and logs whatever Sentinel decided.
 *
 * No-op when SENTINEL_BASE_URL / SENTINEL_API_TOKEN are unset. The POST creates
 * an audit record and enqueues the (long-running) job server-side, so it returns
 * quickly; a short timeout keeps us well inside GitHub's webhook-delivery window.
 */
export async function triggerSentinelAudit(
  config: AppConfig,
  params: SentinelAuditParams,
  logger: Logger
): Promise<void> {
  const { sentinelBaseUrl, sentinelApiToken } = config
  if (!sentinelBaseUrl || !sentinelApiToken) {
    logger.info(
      'Sentinel audit skipped — SENTINEL_BASE_URL/API_TOKEN not set',
      {
        ref: params.ref,
      }
    )
    return
  }

  const url = `${sentinelBaseUrl.replace(/\/+$/, '')}/reviews`
  try {
    const res = await axios.post(
      url,
      {
        owner: params.owner,
        repo: params.repo,
        ref: params.ref,
        versionType: params.versionType,
      },
      {
        timeout: 8000,
        headers: {
          Authorization: `Bearer ${sentinelApiToken}`,
          'Content-Type': 'application/json',
        },
      }
    )

    const data = (res.data ?? {}) as {
      triggered?: boolean
      skipped?: string
      auditId?: string
    }
    if (data.triggered) {
      logger.info('Sentinel audit triggered', {
        repo: `${params.owner}/${params.repo}`,
        ref: params.ref,
        auditId: data.auditId,
      })
    } else {
      logger.info('Sentinel audit not started', {
        repo: `${params.owner}/${params.repo}`,
        ref: params.ref,
        reason: data.skipped ?? 'unknown',
      })
    }
  } catch (err: unknown) {
    logger.warn('Failed to trigger Sentinel audit', {
      repo: `${params.owner}/${params.repo}`,
      ref: params.ref,
      error: getErrorMessage(err),
    })
  }
}
