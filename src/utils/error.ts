/** Normalize an unknown thrown value to a message string. */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
