import { useEffect } from "react"
import { useTaskModal } from "../components/tasks/modal/TaskModalProvider"
import { postToMac } from "../lib/macBridge"

/**
 * Tells the macOS app which of the page's views is showing, as each has its
 * own dropdown size there. A task opened over an event's details is the task
 * view, being on top.
 */
export function useMacDropdownView(expanded: boolean, eventOpen: boolean): void {
  const taskOpen = useTaskModal().openId !== null
  const view = taskOpen ? "task" : eventOpen ? "event" : expanded ? "expanded" : "collapsed"
  useEffect(() => {
    postToMac({ type: "view", view })
  }, [view])
}
