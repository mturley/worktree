import { describe, it, expect } from "vitest"
import { hasUnread, readChangeDidSomething } from "./unread"
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

  it("counts a Slack thread's linked tasks' unread events, which Slack knows nothing of", () => {
    // has_unread stays Slack's own verdict (the server never folds task
    // events into it), so the task part arrives separately.
    expect(hasUnread(base({ type: "slack", id: "C1:1.2", has_unread: false, task_unread_count: 1, unread_count: 1 }))).toBe(true)
    expect(hasUnread(base({ type: "slack", id: "C1:1.2", has_unread: false, task_unread_count: 0 }))).toBe(false)
  })

  it("already counts task events for other types, through unread_count", () => {
    expect(hasUnread(base({ unread_count: 1, task_unread_count: 1 }))).toBe(true)
  })
})

describe("readChangeDidSomething", () => {
  it("is true when the cursor moved", () => {
    expect(readChangeDidSomething({ previous_ts: "a", last_read_ts: "b" })).toBe(true)
    expect(readChangeDidSomething({ previous_ts: null, last_read_ts: "b" })).toBe(true)
  })
  it("is false when the cursor stayed and no mark was cleared", () => {
    expect(readChangeDidSomething({ previous_ts: "a", last_read_ts: "a" })).toBe(false)
    expect(readChangeDidSomething({ previous_ts: "a", last_read_ts: "a", cleared_unread: [] })).toBe(false)
  })
  it("is true when the cursor stayed but an unread mark was cleared", () => {
    expect(readChangeDidSomething({ previous_ts: "a", last_read_ts: "a", cleared_unread: [{ id: "e1", ts: "t" }] })).toBe(true)
  })
})
