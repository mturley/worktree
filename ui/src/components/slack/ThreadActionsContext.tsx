import { createContext, useContext } from "react"

interface ThreadActions {
  /**
   * Adds a linked thread to the current worktree as a resource. Undefined
   * when there is no worktree context (ThreadView rendered standalone), in
   * which case the "Add thread" affordance is hidden rather than broken.
   */
  addThread?: (url: string) => Promise<void>
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
