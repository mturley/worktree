import { useInfiniteQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import type { TimelineEvent } from "../api/types"

/**
 * Events per request. Smaller than the old fixed 100 because pages are now
 * followable: the first screen arrives sooner and the rest is one click away.
 */
export const TIMELINE_PAGE_SIZE = 50

/**
 * What every timeline consumer sees. The react-query page structure is
 * flattened here on purpose — consumers render one list and a "load more"
 * control, and none of them has a reason to know about page boundaries.
 */
export interface TimelineResult {
  events: TimelineEvent[]
  isLoading: boolean
  error: unknown
  hasMore: boolean
  loadMore: () => void
  loadingMore: boolean
}

/**
 * A short page means the server ran out of events, so there is nothing more
 * to ask for. The cursor alone cannot tell us this: next_cursor is just the
 * last event's timestamp, and is non-empty even on the final page.
 */
function nextCursor(last: { events: TimelineEvent[]; next_cursor: string }): string | undefined {
  if (last.events.length < TIMELINE_PAGE_SIZE) return undefined
  return last.next_cursor || undefined
}

function flatten(q: ReturnType<typeof useInfiniteQuery<{ events: TimelineEvent[]; next_cursor: string }>>): TimelineResult {
  return {
    events: q.data?.pages.flatMap((p) => p.events) ?? [],
    // Only the first page counts as "loading"; later pages have content on
    // screen already and get the button's own spinner instead.
    isLoading: q.isLoading,
    error: q.error,
    hasMore: q.hasNextPage,
    loadMore: () => void q.fetchNextPage(),
    loadingMore: q.isFetchingNextPage,
  }
}

export function useGlobalTimeline(archived: boolean, resourceTypes: string[] = []): TimelineResult {
  return flatten(
    useInfiniteQuery({
      // The filter is part of the key, so toggling it is a normal cache-keyed
      // fetch and toggling back is a cache hit. Sorted so the same selection
      // in a different click order reuses one cache entry.
      queryKey: ["timeline", "global", archived, [...resourceTypes].sort().join(",")],
      queryFn: ({ pageParam }) => api.globalTimeline(archived, TIMELINE_PAGE_SIZE, pageParam, resourceTypes),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: nextCursor,
    }),
  )
}

export function useWorktreeTimeline(
  path: string,
  resource?: { type: string; id: string },
  resourceTypes: string[] = [],
): TimelineResult {
  return flatten(
    // The resource is part of the key so switching selection is a normal
    // cache-keyed fetch and switching back to unfiltered is a cache hit. Kept
    // as separate array elements (not a collapsed `${type}:${id}` string) so
    // the key composes cleanly with query-key matching elsewhere.
    useInfiniteQuery({
      queryKey: [
        "timeline", "worktree", path, resource?.type ?? "", resource?.id ?? "",
        [...resourceTypes].sort().join(","),
      ],
      queryFn: ({ pageParam }) => api.worktreeTimeline(path, TIMELINE_PAGE_SIZE, resource, pageParam, resourceTypes),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: nextCursor,
      enabled: !!path,
    }),
  )
}
