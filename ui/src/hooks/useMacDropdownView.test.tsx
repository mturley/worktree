import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import { TaskModalProvider, useTaskModal, type TaskModal } from "../components/tasks/modal/TaskModalProvider"
import { useMacDropdownView } from "./useMacDropdownView"

const post = vi.fn()
beforeEach(() => {
  window.webkit = { messageHandlers: { worktree: { postMessage: post } } }
})
afterEach(() => {
  delete window.webkit
  post.mockReset()
  window.history.replaceState({}, "", "/")
  cleanup()
})

let modal: TaskModal | null = null
const Probe = ({ expanded = false }: { expanded?: boolean }) => {
  useMacDropdownView(expanded)
  modal = useTaskModal()
  return null
}
const wrap = (expanded = false) => (
  <TaskModalProvider><Probe expanded={expanded} /></TaskModalProvider>
)

describe("useMacDropdownView", () => {
  it("names the collapsed or expanded mode while no task is open", () => {
    window.history.replaceState({}, "", "/mini")
    const { rerender } = render(wrap())
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "collapsed", taskOpen: false })
    rerender(wrap(true))
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "expanded", taskOpen: false })
  })

  it("says a task is open, keeping the mode, and when it closes", () => {
    // Opened from the URL, so close replaces it at once.
    window.history.replaceState({}, "", "/mini?task=7")
    render(wrap(true))
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "expanded", taskOpen: true })
    act(() => modal!.close())
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "expanded", taskOpen: false })
  })
})
