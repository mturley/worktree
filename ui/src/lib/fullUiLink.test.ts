import { describe, expect, it } from "vitest"
import type { Task, TimelineEvent } from "../api/types"
import { eventFullUiHref, taskFullUiHref } from "./fullUiLink"
import { resourceParam } from "./resourceKey"

const task = (over: Partial<Task>) => ({ id: 7, links: [], implicit_worktrees: [], ...over }) as unknown as Task
const event = (over: Partial<TimelineEvent>) =>
  ({ id: "ev/1", resource_type: "pr", resource_id: "o/r#1", worktree_paths: ["/wt/a", "/wt/b"], ...over }) as TimelineEvent

describe("taskFullUiHref", () => {
  it("opens the task over its first worktree", () => {
    expect(taskFullUiHref(task({ implicit_worktrees: ["/wt/a", "/wt/b"] }))).toBe("/worktree/%2Fwt%2Fa?task=7")
  })
  it("opens over the home page with no worktree", () => {
    expect(taskFullUiHref(task({}))).toBe("/?task=7")
  })
})

describe("eventFullUiHref", () => {
  it("opens the event over its resource in its first worktree", () => {
    expect(eventFullUiHref(event({}))).toBe(`/worktree/%2Fwt%2Fa?${resourceParam({ type: "pr", id: "o/r#1" })}&event=ev%2F1`)
  })
  it("opens over the home page with no worktree", () => {
    expect(eventFullUiHref(event({ worktree_paths: [] }))).toBe("/?event=ev%2F1")
  })
  it("opens a task's event as that task", () => {
    expect(eventFullUiHref(event({ resource_type: "task", resource_id: "7" }))).toBe("/worktree/%2Fwt%2Fa?task=7")
    expect(eventFullUiHref(event({ resource_type: "task", resource_id: "7", worktree_paths: [] }))).toBe("/?task=7")
  })
})
