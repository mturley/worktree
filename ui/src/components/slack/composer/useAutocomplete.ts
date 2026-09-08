import { useEffect, useMemo, useRef, useState } from 'react'
import { autocomplete, type AutocompleteItem } from '../../../api/slackApi'
import type { TriggerMatch } from './detectTrigger'
import { localCandidates, mergeCandidates, type LocalContext } from './candidates'

const DEBOUNCE_MS = 150

/**
 * The hybrid lookup: local candidates paint immediately, the server's fill in.
 *
 * Every Slack call this makes is caused by a keystroke, and the debounce plus
 * the server's TTL cache are what keep that from becoming a burst — see the
 * token-revocation note in docs/reverse-engineering/slack-web-api.md.
 */
export function useAutocomplete(
  match: TriggerMatch | null,
  channel: string,
  ctx: LocalContext,
): { items: AutocompleteItem[]; degraded: boolean } {
  const [remote, setRemote] = useState<AutocompleteItem[]>([])
  const [degraded, setDegraded] = useState(false)
  // Monotonic request id: only the newest response may be applied.
  const seq = useRef(0)

  const trigger = match?.trigger
  const query = match?.query ?? ''

  const local = useMemo(
    () => (trigger ? localCandidates(trigger, query, ctx) : []),
    [trigger, query, ctx],
  )

  useEffect(() => {
    if (!trigger) {
      setRemote([])
      setDegraded(false)
      return
    }
    const id = ++seq.current
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      const results = await autocomplete(trigger, query, channel, controller.signal)
      if (seq.current !== id) {
        return // a newer query has been issued; this answer is stale
      }
      setRemote(results)
      // autocomplete() returns [] both for "no matches" and for a failed
      // request; treating a non-empty local list with an empty remote one as
      // degraded is the honest reading, and only affects a hint line.
      setDegraded(results.length === 0 && query.length > 0)
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [trigger, query, channel])

  const items = useMemo(() => mergeCandidates(local, remote), [local, remote])
  return { items, degraded }
}
