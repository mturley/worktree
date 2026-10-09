import { describe, it, expect } from "vitest"
import type { TimelineEvent } from "../api/types"
import { messageFocus } from "./openEvent"

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
