import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"

/**
 * How often to re-read watcher status.
 *
 * Two rates, because the answer changes at two speeds. Idle, the only thing
 * moving is the "N min ago" text and the background poll loop's own interval,
 * so a slow tick is plenty. While a poll is in flight the spinner has to stop
 * promptly when it finishes, and there is no push channel for that — the SSE
 * stream signals new EVENTS, not poller state, and a poll that produces
 * nothing new emits nothing at all.
 */
const IDLE_MS = 15_000
const POLLING_MS = 1_000

export function useWatchers() {
  return useQuery({
    queryKey: ["watchers"],
    queryFn: api.watchers,
    refetchInterval: (query) => (query.state.data?.polling ? POLLING_MS : IDLE_MS),
    // The status is worth showing even while stale; a blank header while a
    // refetch lands reads as breakage.
    placeholderData: (prev) => prev,
  })
}

/**
 * Refreshes all three watchers on demand.
 *
 * The server starts the poll and returns immediately, so this mutation
 * settling means "the poll was accepted", NOT "the poll finished". The
 * spinner is driven by the `polling` flag instead, which is also true for the
 * background loop's own polls — the honest answer to "is anything fetching".
 *
 * The immediate invalidate is what makes the spinner appear at once rather
 * than up to a full idle tick later.
 */
export function usePollWatchers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.pollWatchers,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["watchers"] })
    },
  })
}

/**
 * The watcher responsible for one resource type ("pr", "jira", "slack").
 *
 * Keyed by TYPE rather than poller name because that is what callers have —
 * a resource knows it is a "pr", not that the poller watching it is called
 * "github". The server sends both so this mapping lives in exactly one place.
 */
export function useWatcherStatus(type: string) {
  const { data } = useWatchers()
  return data?.watchers.find((w) => w.type === type)
}
