import axios from 'axios'
import type { Logger } from 'winston'

/**
 * Fire-and-forget dispatch of a parity job to the service's own /parity worker
 * endpoint. The parity scan runs an agent per SDK and far exceeds GitHub's 10s
 * webhook-delivery limit, so the webhook must return immediately — this kicks
 * the job onto a separate request and does NOT wait for it to finish.
 *
 * PoC transport: a self-POST with a short client timeout (enough to transmit
 * the tiny body so the worker request starts, but we don't block on the long
 * job). Production should swap this for Cloud Tasks / Pub/Sub for durability.
 */
export async function triggerParityCheck(
  baseUrl: string,
  token: string | undefined,
  version: string,
  logger: Logger
): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, '')}/parity`
  try {
    await axios.post(
      url,
      { version },
      {
        timeout: 1500,
        headers: token ? { 'x-cloud-scheduler-token': token } : {},
      }
    )
  } catch (err: unknown) {
    // A timeout here is EXPECTED — the worker keeps running after we stop
    // waiting. Only a connection refusal is worth noting.
    if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') {
      logger.info('Parity job dispatched (worker running in background)', {
        version,
      })
      return
    }
    logger.warn('Failed to dispatch parity job', {
      version,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
