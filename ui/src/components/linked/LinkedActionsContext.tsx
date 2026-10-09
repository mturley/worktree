import { createContext, useContext } from "react"
import type { ResourceKey } from "../../lib/resourceKey"

export interface LinkedActions {
  /** Open the follow modal pre-filled with this URL (Related preselected). */
  requestFollow?: (url: string) => void
  /** This worktree's resource key for (type, id), or null if not followed. */
  trackedResource?: (type: string, id: string) => ResourceKey | null
  /** Select a followed resource in the detail pane. */
  selectResource?: (key: ResourceKey) => void
}

/**
 * What a Linked Resources row can do to the surrounding worktree. Supplied by
 * WorktreeDetailPage — the only place that knows the resource list and the
 * selection — via context, like ThreadActionsContext, because rows sit
 * several layers below it. Empty outside a worktree: Follow simply hides.
 */
export const LinkedActionsContext = createContext<LinkedActions>({})

export function useLinkedActions(): LinkedActions {
  return useContext(LinkedActionsContext)
}
