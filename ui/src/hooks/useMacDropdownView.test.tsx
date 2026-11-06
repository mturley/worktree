import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook } from "@testing-library/react"
import { TaskModalProvider, useTaskModal, type TaskModal } from "../components/tasks/modal/TaskModalProvider"
import { TASK_MIN_WIDTH, useMacDropdownView, useTaskOpenResizesDropdown } from "./useMacDropdownView"

const post = vi.fn()
beforeEach(() => {
  window.webkit = { messageHandlers: { worktree: { postMessage: post } } }
})
const initialWidth = window.innerWidth
const setWidth = (w: number) => Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true })
afterEach(() => {
  setWidth(initialWidth)
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

describe("useTaskOpenResizesDropdown", () => {
  const hook = (width: number) => {
    setWidth(width)
    return renderHook(({ open }) => useTaskOpenResizesDropdown(open), { initialProps: { open: false } })
  }

  it("is true for an open in a dropdown narrower than the task needs, through its close", () => {
    const { result, rerender } = hook(TASK_MIN_WIDTH - 1)
    rerender({ open: true })
    expect(result.current).toBe(true)
    // The app has widened it by the close, which still resizes.
    setWidth(TASK_MIN_WIDTH)
    rerender({ open: false })
    expect(result.current).toBe(true)
  })

  it("is false for an open in a dropdown already wide enough", () => {
    const { result, rerender } = hook(TASK_MIN_WIDTH)
    rerender({ open: true })
    expect(result.current).toBe(false)
  })

  it("is false outside the macOS app", () => {
    delete window.webkit
    const { result, rerender } = hook(400)
    rerender({ open: true })
    expect(result.current).toBe(false)
  })
})
