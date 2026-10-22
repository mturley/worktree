import { createContext, useContext } from "react"

import type { TaskEventSnapshot } from "../../api/types"
import type { ResourceKey } from "../../lib/resourceKey"

interface ThreadActions {
  /**
   * Opens the add-resource modal with this thread's URL pre-filled, rather
   * than adding it outright: adding is not a single decision — Focus vs
   * Related, and an optional custom name and description, all belong to it —
   * and a one-click add would silently pick defaults the user then has to go
   * and correct on the resource card.
   *
   * Undefined when there is no worktree context (ThreadView rendered
   * standalone), in which case the thread-unfurl affordances hide rather
   * than break.
   */
  requestAddThread?: (url: string) => void
  /**
   * Returns the resource key if this worktree already tracks the thread at
   * that URL, else null. Lets the unfurl card derive its state from the
   * resource list rather than remembering what it just added — so it stays
   * correct across navigation and for threads added elsewhere.
   */
  trackedThread?: (url: string) => ResourceKey | null
  /** Selects an already-tracked resource, showing it in the detail pane. */
  selectThread?: (key: ResourceKey) => void
  /**
   * Makes a task from a message (key `slack:<channel>:<ts>`, plus the
   * snapshot the server stores, since a message is not a watcher event) and
   * opens it. Undefined where there are no tasks to open (ThreadView
   * rendered standalone): the message's "Make task" action hides.
   */
  makeTask?: (key: string, snapshot: TaskEventSnapshot) => void
}

/**
 * Actions a thread's embedded content can invoke on the surrounding worktree.
 *
 * Supplied via context because the consumer (a thread-unfurl card inside an
 * attachment) sits several layers below the pane that knows the worktree
 * path — threading a callback through ThreadView and Message would churn
 * both for something only one leaf uses.
 */
export const ThreadActionsContext = createContext<ThreadActions>({})

export function useThreadActions(): ThreadActions {
  return useContext(ThreadActionsContext)
}
