import { useEffect } from "react"
import { useTaskModal } from "../components/tasks/modal/TaskModalProvider"
import { postToMac } from "../lib/macBridge"

/**
 * Tells the macOS app which mode the page is in (collapsed or expanded, each
 * with its own remembered dropdown size) and whether a task is open: the app
 * widens the dropdown while one is, so the task's sidebar sits beside its
 * content (see TASK_MIN_WIDTH in the app's ResizeGrip.swift).
 */
export function useMacDropdownView(expanded: boolean): void {
  const taskOpen = useTaskModal().openId !== null
  const view = expanded ? "expanded" : "collapsed"
  useEffect(() => {
    postToMac({ type: "view", view, taskOpen })
  }, [view, taskOpen])
}
