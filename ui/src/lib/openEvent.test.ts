import { describe, it, expect } from "vitest"
import type { TimelineEvent } from "../api/types"
import { clearFollowResource, followResourceState, isArchivedEvent, messageFocus, readFollowResource } from "./openEvent"

const ev = (o: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "e1", ts: "2026-10-01T00:00:00Z", external_ts: "1791561570.240519", source: "slack",
  type: "slack_reply", type_label: "", title: "t", body: "", author: "",
  resource_type: "slack", resource_id: "C1:1791500000.000100", resource_url: "u",
  resource_title: "", worktrees: [], ...o,
})

describe("messageFocus", () => {
  it("targets a Slack event's message by its own Slack ts", () => {
    expect(messageFocus(ev())).toMatchObject({ type: "slack", id: "C1:1791500000.000100", ts: "1791561570.240519" })
  })

  it("issues a new key every time, so the same message can flash again", () => {
    expect(messageFocus(ev())!.key).not.toBe(messageFocus(ev())!.key)
  })

  it("is null for a Slack event with no message, and for other sources", () => {
    expect(messageFocus(ev({ external_ts: "" }))).toBeNull()
    expect(messageFocus(ev({ resource_type: "pr", resource_id: "o/r#1" }))).toBeNull()
  })
})

describe("isArchivedEvent", () => {
  it("is true for a resource event no worktree follows", () => {
    expect(isArchivedEvent(ev({ worktree_paths: [] }))).toBe(true)
    expect(isArchivedEvent(ev())).toBe(true)
  })

  it("is false while a worktree follows it, or with no resource at all", () => {
    expect(isArchivedEvent(ev({ worktrees: ["b"], worktree_paths: ["/wt/b"] }))).toBe(false)
    expect(isArchivedEvent(ev({ resource_type: "", resource_id: "" }))).toBe(false)
  })

  it("for a task event, follows the task's own archived flag, not its worktrees", () => {
    const task = { resource_type: "task", resource_id: "7", source: "tasks" }
    expect(isArchivedEvent(ev({ ...task, worktree_paths: [] }))).toBe(false)
    expect(isArchivedEvent(ev({ ...task, worktree_paths: [], archived: true }))).toBe(true)
  })
})

describe("followResource state", () => {
  it("round-trips through history state and clears", () => {
    window.history.replaceState(followResourceState({ url: "https://x/1", name: "N", description: "D" }), "")
    expect(readFollowResource()).toEqual({ url: "https://x/1", name: "N", description: "D" })
    clearFollowResource()
    expect(readFollowResource()).toBeNull()
  })

  it("rejects malformed state", () => {
    window.history.replaceState({ followResource: { url: 3 } }, "")
    expect(readFollowResource()).toBeNull()
    window.history.replaceState({ followResource: { url: "u", name: 5 } }, "")
    expect(readFollowResource()).toEqual({ url: "u", name: undefined, description: undefined })
    window.history.replaceState(null, "")
  })
})
