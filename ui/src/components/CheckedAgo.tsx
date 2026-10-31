import { useNow } from "../hooks/useNow"
import { relativeTime } from "../lib/relativeTime"

/** " · checked 12s ago" after a section's description; nothing before the first check. */
export function CheckedAgo({ at }: { at: string | undefined }) {
  useNow(5000) // keeps the label moving between heartbeats
  if (!at) return null
  return <> · checked {relativeTime(at)}</>
}
