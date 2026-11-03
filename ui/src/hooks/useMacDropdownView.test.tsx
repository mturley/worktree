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
const Probe = ({ expanded = false, eventOpen = false }: { expanded?: boolean; eventOpen?: boolean }) => {
  useMacDropdownView(expanded, eventOpen)
  modal = useTaskModal()
  return null
}
const wrap = (expanded = false, eventOpen = false) => (
  <TaskModalProvider><Probe expanded={expanded} eventOpen={eventOpen} /></TaskModalProvider>
)

describe("useMacDropdownView", () => {
  it("names the collapsed or expanded view while no modal is open", () => {
    window.history.replaceState({}, "", "/mini")
    const { rerender } = render(wrap())
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "collapsed" })
    rerender(wrap(true))
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "expanded" })
  })

  it("names the event view while an event's details are open", () => {
    window.history.replaceState({}, "", "/mini")
    const { rerender } = render(wrap(true, true))
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "event" })
    rerender(wrap(true, false))
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "expanded" })
  })

  it("names the task view while a task is open, and returns to the mode on close", () => {
    // Opened from the URL, so close replaces it at once.
    window.history.replaceState({}, "", "/mini?task=7")
    render(wrap(true))
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "task" })
    act(() => modal!.close())
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "expanded" })
  })

  it("prefers the task view when a task opens over an event's details", () => {
    window.history.replaceState({}, "", "/mini?task=7")
    render(wrap(false, true))
    expect(post).toHaveBeenLastCalledWith({ type: "view", view: "task" })
  })
})
