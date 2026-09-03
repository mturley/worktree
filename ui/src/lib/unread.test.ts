import { describe, it, expect } from "vitest"
import { hasUnread } from "./unread"
import type { ResourceDTO } from "../api/types"

const base = (over: Partial<ResourceDTO>): ResourceDTO =>
  ({ type: "pr", id: "o/r#1", url: "u", primary: true, ...over })

describe("hasUnread", () => {
  it("reads unread_count for a PR", () => {
    expect(hasUnread(base({ unread_count: 2 }))).toBe(true)
    expect(hasUnread(base({ unread_count: 0 }))).toBe(false)
    expect(hasUnread(base({}))).toBe(false)
  })

  it("reads unread_count for a Jira issue", () => {
    expect(hasUnread(base({ type: "jira", id: "J-1", unread_count: 1 }))).toBe(true)
  })

  it("reads has_unread for a Slack thread, ignoring unread_count", () => {
    expect(hasUnread(base({ type: "slack", id: "C1:1.2", has_unread: true }))).toBe(true)
    // Slack never gets a cursor, so a count here would be meaningless — the
    // thread's own read state is the only authority.
    expect(hasUnread(base({ type: "slack", id: "C1:1.2", has_unread: false, unread_count: 5 }))).toBe(false)
  })
})
