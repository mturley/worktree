import { useCallback, useState } from "react"
import { Alert, Text } from "@mantine/core"

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "the request failed"
}

/**
 * A Details-tab section's writes: `run` fires one and keeps its failure for
 * `alert` to show. The mutation's own invalidation refetches the task either
 * way, so a failed write needs no local rollback beyond what it optimistically
 * showed.
 */
export function useSectionAction() {
  const [error, setError] = useState<string | null>(null)
  const run = useCallback((p: Promise<unknown>) => {
    setError(null)
    p.catch((e: unknown) => setError(errorText(e)))
  }, [])
  const alert = error ? (
    <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)} py={4}>
      <Text size="xs">Couldn't save: {error}</Text>
    </Alert>
  ) : null
  return { run, alert, setError }
}
