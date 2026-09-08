import { useEffect, useMemo, useRef, useState } from 'react'
import { autocomplete, type AutocompleteItem } from '../../../api/slackApi'
import type { TriggerMatch } from './detectTrigger'
import { localCandidates, mergeCandidates, type LocalContext } from './candidates'

const DEBOUNCE_MS = 150

/**
 * Runs the actual fetch and hands its result to `onResult` — unless
 * `isStale()` says otherwise by the time it resolves. Pulled out of the
 * effect as a plain, React-free function so the unmount-cancellation
 * guard is directly unit-testable: React 19 silently no-ops a state update
 * on an unmounted component (no warning, no error — confirmed empirically),
 * so a black-box test driving the hook through React's lifecycle cannot
 * observe whether the guard fired. Testing this function directly, with
 * `onResult` standing in for the setter, can.
 */
export async function fetchAutocompleteResult(
  trigger: '@' | ':' | '#',
  query: string,
  channel: string,
  signal: AbortSignal,
  isStale: () => boolean,
  onResult: (results: AutocompleteItem[]) => void,
): Promise<void> {
  const results = await autocomplete(trigger, query, channel, signal)
  if (isStale()) {
    return // unmounted, or a newer query has been issued — this answer is stale
  }
  onResult(results)
}

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
    // seq.current alone does not catch unmount: if the debounce timer has
    // already fired and the fetch is in flight when the component unmounts,
    // seq.current is untouched by unmount, autocomplete() swallows the
    // resulting AbortError and resolves [], and the seq check passes. This
    // flag is what actually trips on unmount and guards both setState calls
    // (via fetchAutocompleteResult's isStale check).
    let cancelled = false
    const timer = setTimeout(() => {
      void fetchAutocompleteResult(
        trigger,
        query,
        channel,
        controller.signal,
        () => cancelled || seq.current !== id,
        (results) => {
          setRemote(results)
          // autocomplete() returns [] both for "no matches" and for a failed
          // request; treating a non-empty local list with an empty remote one
          // as degraded is the honest reading, and only affects a hint line.
          setDegraded(results.length === 0 && query.length > 0)
        },
      )
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [trigger, query, channel])

  const items = useMemo(() => mergeCandidates(local, remote), [local, remote])
  return { items, degraded }
}
