import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import { TaskModalProvider, useTaskModal, type TaskModal } from "../components/tasks/modal/TaskModalProvider"
import { macWidensForTaskModal, useMacTaskModalWidth } from "./useMacTaskModalWidth"

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
const Probe = () => {
  useMacTaskModalWidth()
  modal = useTaskModal()
  return null
}

describe("useMacTaskModalWidth", () => {
  it("asks for nothing while no task modal is open", () => {
    window.history.replaceState({}, "", "/mini")
    render(<TaskModalProvider><Probe /></TaskModalProvider>)
    expect(post).toHaveBeenLastCalledWith({ type: "minWidth", width: null })
  })

  it("asks for the wide width while a task modal is open, and lets it go on close", () => {
    // Opened from the URL, so close replaces it at once.
    window.history.replaceState({}, "", "/mini?task=7")
    render(<TaskModalProvider><Probe /></TaskModalProvider>)
    // 48em at jsdom's 16px root.
    expect(post).toHaveBeenLastCalledWith({ type: "minWidth", width: 768 })

    act(() => modal!.close())
    expect(post).toHaveBeenLastCalledWith({ type: "minWidth", width: null })
  })
})

describe("macWidensForTaskModal", () => {
  const setWidth = (w: number) => Object.defineProperty(window, "innerWidth", { configurable: true, value: w })
  const original = window.innerWidth
  afterEach(() => setWidth(original))

  it("is true in the app below the wide width, false at or above it", () => {
    setWidth(600)
    expect(macWidensForTaskModal()).toBe(true)
    setWidth(768)
    expect(macWidensForTaskModal()).toBe(false)
  })

  it("is false in a browser, whatever the width", () => {
    delete window.webkit
    setWidth(600)
    expect(macWidensForTaskModal()).toBe(false)
  })
})
