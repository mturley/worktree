import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import type { TimelineEvent } from "../../../api/types"
import { TaskModalProvider, useTaskModal, type TaskModal } from "./TaskModalProvider"

const event = (title: string): TimelineEvent => ({
  id: "task:1", ts: "2026-10-20T00:00:00Z", external_ts: "", source: "tasks", type: "task_created", type_label: "",
  title, body: "", author: "me", resource_type: "task", resource_id: "7", resource_url: "", resource_title: "", worktrees: [],
})

let modal: TaskModal
function Probe() {
  modal = useTaskModal()
  return <span data-testid="focus">{modal.focusEvent?.title ?? "none"}</span>
}

const param = () => new URLSearchParams(window.location.search).get("task")

beforeEach(() => {
  window.history.replaceState({}, "", "/?resource=pr:x")
  render(<TaskModalProvider><Probe /></TaskModalProvider>)
})
afterEach(cleanup)

describe("TaskModalProvider focusEvent", () => {
  it("open(id, { event }) holds the event for that task, out of the URL", () => {
    act(() => modal.open(7, { event: event("Made it") }))
    expect(param()).toBe("7")
    expect(window.location.search).toBe("?resource=pr%3Ax&task=7")
    expect(screen.getByTestId("focus")).toHaveTextContent("Made it")
  })

  it("clearFocusEvent drops it, leaving the task open", () => {
    act(() => modal.open(7, { event: event("Made it") }))
    act(() => modal.clearFocusEvent())
    expect(screen.getByTestId("focus")).toHaveTextContent("none")
    expect(param()).toBe("7")
  })

  it("belongs to the task it was opened with: opening another task drops it", () => {
    act(() => modal.open(7, { event: event("Made it") }))
    act(() => modal.open(8))
    expect(param()).toBe("8")
    expect(screen.getByTestId("focus")).toHaveTextContent("none")
  })

  it("closing drops it", () => {
    act(() => modal.open(7, { event: event("Made it") }))
    act(() => modal.close())
    expect(screen.getByTestId("focus")).toHaveTextContent("none")
  })
})
