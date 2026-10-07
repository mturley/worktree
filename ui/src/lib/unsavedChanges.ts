import { useEffect } from "react"

/**
 * Edits that navigating away would throw away, tab-wide.
 *
 * A component holding text the user typed but has not sent or saved marks
 * itself dirty with useUnsavedChanges; something about to navigate without
 * being asked (CmuxFollower) checks hasUnsavedChanges first. Edits that save
 * themselves on unmount, like worktree notes, are not "unsaved" in this sense
 * and do not register.
 */
const dirty = new Set<symbol>()

export function hasUnsavedChanges(): boolean {
  return dirty.size > 0
}

/** Registers the calling component as holding unsaved edits while `isDirty`. */
export function useUnsavedChanges(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return
    const token = Symbol("unsaved")
    dirty.add(token)
    return () => { dirty.delete(token) }
  }, [isDirty])
}
