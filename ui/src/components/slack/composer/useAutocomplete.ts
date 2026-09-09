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

/** The server's answer, tagged with the query it answers.
 *
 * Tagging is what makes stale results impossible to render (final-review C1).
 * Clearing `remote` on every query change would also work, but it blanks the
 * remote half of the menu on every keystroke — visible flicker on a list the
 * user is actively arrowing through. Tagging keeps the previous answer in
 * state (so no re-fetch churn) while making it INELIGIBLE for display until
 * its query matches the live one again. */
interface RemoteAnswer {
  trigger: '@' | ':' | '#'
  query: string
  items: AutocompleteItem[]
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
  const [remote, setRemote] = useState<RemoteAnswer | null>(null)
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
      setRemote(null)
      return
    }
    const id = ++seq.current
    const controller = new AbortController()
    // seq.current alone does not catch unmount: if the debounce timer has
    // already fired and the fetch is in flight when the component unmounts,
    // seq.current is untouched by unmount, autocomplete() swallows the
    // resulting AbortError and resolves, and the seq check passes. This
    // flag is what actually trips on unmount and guards the setState call
    // (via fetchAutocompleteResult's isStale check).
    let cancelled = false
    const timer = setTimeout(() => {
      void fetchAutocompleteResult(
        trigger,
        query,
        channel,
        controller.signal,
        () => cancelled || seq.current !== id,
        (results) => setRemote({ trigger, query, items: results }),
      )
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [trigger, query, channel])

  // An answer is only usable while it still answers the LIVE query. Anything
  // else is a candidate for a query the user has already typed past.
  const fresh = trigger && remote && remote.trigger === trigger && remote.query === query ? remote : null

  const items = useMemo(() => mergeCandidates(local, fresh?.items ?? []), [local, fresh])
  // autocomplete() returns [] both for "no matches" and for a failed
  // request; treating a non-empty local list with an empty remote one
  // as degraded is the honest reading, and only affects a hint line.
  const degraded = fresh !== null && fresh.items.length === 0 && query.length > 0
  return { items, degraded }
}
