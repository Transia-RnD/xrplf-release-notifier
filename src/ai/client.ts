import Anthropic from '@anthropic-ai/sdk'

/**
 * Single place the app constructs the Anthropic client. `maxRetries` defaults
 * above the SDK's 2 so transient 429s (the per-minute input-token limit) self-
 * heal via Retry-After backoff across all AI callsites; the parity agent makes
 * many sequential calls and passes a higher value.
 */
export function createAnthropicClient(
  apiKey: string,
  maxRetries = 4
): Anthropic {
  return new Anthropic({ apiKey, maxRetries })
}
