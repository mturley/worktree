import { useState } from "react"
import { api } from "../api/client"
import type { ResourceDTO } from "../api/types"
import { resourceLabel } from "../lib/search"
import { showUndoToast } from "../components/UndoToast"

/**
 * Unfollows `r` from the worktree at `path`, then offers to take it back: an
 * undo toast whose Undo follows it again in the same group, at the same place
 * and with the same notify toggle (the server's snapshot of what it removed).
 *
 * `onRemoved` runs once the unfollow lands, and again once an undo settles,
 * for the caller to refetch the list either way. A failure is left in `error`
 * for the caller's confirm prompt to show; the prompt stays open.
 */
export function useUnfollowResource({ r, path, onRemoved }: { r: ResourceDTO; path: string; onRemoved: () => void }) {
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Resolves true when the resource was unfollowed. */
  const unfollow = async (): Promise<boolean> => {
    setRemoving(true)
    try {
      const res = await api.removeResource({ path, type: r.type, id: r.id })
      setError(null)
      onRemoved()
      // No snapshot: the worktree wasn't following it, so nothing to undo.
      const removed = res?.removed
      if (removed) {
        showUndoToast({
          message: `Unfollowed “${resourceLabel(r)}”`,
          undo: () => api.restoreResource({ path, removed }),
          onSettled: onRemoved,
        })
      }
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setRemoving(false)
    }
  }

  return { unfollow, removing, error, clearError: () => setError(null) }
}
