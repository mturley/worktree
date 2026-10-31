import { useNow } from "../hooks/useNow"
import { relativeTime } from "../lib/relativeTime"

/** Older than this, a section's data has stopped updating: its checks run every 5-10s. */
const STALE_MS = 60_000

/**
 * " · checked 3m ago" after a section's description, only once its last
 * check is stale. While the stream is live the checks are seconds old and
 * the label would be noise; it appears when updates stop arriving (a hidden
 * tab's closed stream, a dropped connection, a stopped server).
 */
export function CheckedAgo({ at }: { at: string | undefined }) {
  const now = useNow(5000) // re-evaluated between heartbeats, so it can appear
  if (!at) return null
  const t = new Date(at).getTime()
  if (!t || now.getTime() - t < STALE_MS) return null
  return <> · checked {relativeTime(at)}</>
}
