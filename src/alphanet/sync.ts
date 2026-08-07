import type { Logger } from 'winston'
import type { AppConfig } from '../config'

export type SyncOutcome = 'dispatched' | 'debounced' | 'disabled' | 'failed'

const FETCH_TIMEOUT_MS = 10_000

let lastDispatchMs = 0

/** Test hook — module-level debounce state survives between tests otherwise. */
export function resetAlphanetSyncDebounce(): void {
  lastDispatchMs = 0
}

/**
 * Tell sentinel that upstream develop moved so it can run a Stage-1 branch
 * sync (merge develop into every alphanet branch, build-gate, push).
 *
 * Debounced: develop can advance several times an hour, and each sync run
 * costs build-gate compiles on the sentinel box. Never throws — a failed
 * dispatch is logged and the next develop push retries naturally.
 */
export async function maybeDispatchAlphanetSync(
  config: AppConfig,
  logger: Logger
): Promise<SyncOutcome> {
  if (!config.alphanetSyncUrl || !config.alphanetSyncSecret) {
    return 'disabled'
  }

  const debounceMs = config.alphanetSyncDebounceMinutes * 60_000
  const now = Date.now()
  if (debounceMs > 0 && now - lastDispatchMs < debounceMs) {
    logger.info('Alphanet sync debounced', {
      sinceLastMs: now - lastDispatchMs,
      debounceMs,
    })
    return 'debounced'
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const response = await fetch(config.alphanetSyncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': config.alphanetSyncSecret,
      },
      body: JSON.stringify({ reason: 'develop-push' }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!response.ok) {
      logger.error('Alphanet sync dispatch rejected', {
        status: response.status,
      })
      return 'failed'
    }
    lastDispatchMs = now
    logger.info('Alphanet sync dispatched', { status: response.status })
    return 'dispatched'
  } catch (error) {
    logger.error('Alphanet sync dispatch failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return 'failed'
  }
}
