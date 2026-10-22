import { describe, expect, it } from "vitest"
import type { TimelineEvent } from "../api/types"
import { eventTaskKey, eventTaskKeys } from "./taskEventKey"

const UUID = "3f1c2a9e-8b7d-4e6f-9a01-2b3c4d5e6f70"

const ev = (o: Partial<TimelineEvent>): TimelineEvent => ({
  id: UUID, ts: "", external_ts: "", source: "github", type: "pr_comment", type_label: "", title: "t",
  body: "", author: "", resource_type: "pr", resource_id: "o/r#1", resource_url: "", resource_title: "",
  worktrees: [], ...o,
})

describe("eventTaskKey", () => {
  it("keys a watcher event (a UUID) as ev:<id>", () => {
    expect(eventTaskKey(ev({}))).toBe(`ev:${UUID}`)
  })

  it.each(["task:5", "ev:x", "slack:C:1"])("is null for %s", (id) => {
    expect(eventTaskKey(ev({ id }))).toBeNull()
    expect(eventTaskKeys(ev({ id }))).toEqual([])
  })

  it("is null for a task's own event", () => {
    expect(eventTaskKey(ev({ source: "tasks" }))).toBeNull()
  })
})

describe("eventTaskKeys", () => {
  it("is just the ev: key for a non-Slack event", () => {
    expect(eventTaskKeys(ev({}))).toEqual([`ev:${UUID}`])
  })

  it("adds the slack:<channel>:<ts> key for a Slack thread event", () => {
    const e = ev({ resource_type: "slack", resource_id: "C1:100.000", external_ts: "200.000" })
    expect(eventTaskKeys(e)).toEqual([`ev:${UUID}`, "slack:C1:200.000"])
  })
})
