import { describe, expect, it } from "vitest"
import type { TimelineEvent } from "../api/types"
import type { Message, User } from "../api/slackApi"
import { eventTaskKey, slackMessageSnapshot } from "./taskEventKey"

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
  })

  it("is null for a task's own event", () => {
    expect(eventTaskKey(ev({ source: "tasks" }))).toBeNull()
  })
})

describe("slackMessageSnapshot", () => {
  const msg = (Text: string): Message => ({
    TS: "1700000000.000100", UserID: "U1", Text, Blocks: null, Reactions: null, Edited: false, Files: null, Attachments: null,
  })
  const users: Record<string, User> = {
    U1: { ID: "U1", Name: "ann", RealName: "Ann A", DisplayName: "Ann", Avatar72: "" },
  }
  const thread = { channel: "C1", threadTs: "1690000000.000000" }

  it("titles it with the first line as plain text", () => {
    const s = slackMessageSnapshot(msg("\n  <@U1> see <https://x.io|the doc> &amp; <#C9|general>  \nmore"), users, thread)
    expect(s.title).toBe("@Ann see the doc & #general")
    expect(s.body).toContain("<@U1>")
    expect(s.resource_id).toBe("C1:1690000000.000000")
  })

  it("names a message with no text by its author", () => {
    expect(slackMessageSnapshot(msg(""), users, thread).title).toBe("Message from Ann")
  })
})
