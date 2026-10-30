import { useEffect } from "react"
import { useTaskModal } from "../components/tasks/modal/TaskModalProvider"
import { hasMacBridge, postToMac } from "../lib/macBridge"
import { wideMinPx } from "./useIsWide"

/**
 * Asks the macOS app for the wide layout's width while a task modal is open,
 * so the modal shows its sidebar beside the tabs rather than below them, and
 * lets it go when the modal closes. The app widens the dropdown only if it is
 * narrower than that, and puts the user's own width back afterwards.
 */
export function useMacTaskModalWidth(): void {
  const open = useTaskModal().openId !== null
  useEffect(() => {
    postToMac({ type: "minWidth", width: open ? wideMinPx() : null })
  }, [open])
}

/**
 * Whether opening a task modal now makes the macOS app widen the dropdown:
 * hosted by the app, in a window narrower than the wide layout. The app
 * widens exactly then, and narrows again on close.
 */
export function macWidensForTaskModal(): boolean {
  return hasMacBridge() && window.innerWidth < wideMinPx()
}
