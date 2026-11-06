import { useEffect, useState } from "react"
import { useTaskModal } from "../components/tasks/modal/TaskModalProvider"
import { hasMacBridge, postToMac } from "../lib/macBridge"

/**
 * Tells the macOS app which mode the page is in (collapsed or expanded, each
 * with its own remembered dropdown size) and whether a task is open: the app
 * widens the dropdown while one is, so the task's sidebar sits beside its
 * content (see TASK_MIN_WIDTH).
 */
export function useMacDropdownView(expanded: boolean): void {
  const taskOpen = useTaskModal().openId !== null
  const view = expanded ? "expanded" : "collapsed"
  useEffect(() => {
    postToMac({ type: "view", view, taskOpen })
  }, [view, taskOpen])
}

/**
 * The narrowest the macOS app lets the dropdown be while a task is open: the
 * page's `sm` breakpoint (48em), from which the task's sidebar sits beside its
 * content. The app's twin is `taskMinWidth` in ResizeGrip.swift.
 */
export const TASK_MIN_WIDTH = 768

/**
 * Whether the task modal's current open (and the close that ends it) changes
 * the dropdown's width: under the macOS app, with the dropdown narrower than
 * TASK_MIN_WIDTH when the task opened. Decided at the open and kept until the
 * close, by which time the app has widened the dropdown, so the close is
 * judged by the width it will return to.
 */
export function useTaskOpenResizesDropdown(open: boolean): boolean {
  const [wasOpen, setWasOpen] = useState(false)
  const [resizes, setResizes] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setResizes(hasMacBridge() && window.innerWidth < TASK_MIN_WIDTH)
  }
  return resizes
}
