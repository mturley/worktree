import { describe, it, expect } from "vitest"
import { resolveMentionsToText } from "./resolveMentions"

const users = {
  U123: { DisplayName: "ana", RealName: "Ana Diaz" },
  U456: { DisplayName: "", RealName: "Bo Chen" },
} as never

describe("resolveMentionsToText", () => {
  it("resolves a user mention to the display name", () => {
    expect(resolveMentionsToText("hey <@U123> look", users)).toBe("hey @ana look")
  })

  it("falls back to the real name when there is no display name", () => {
    expect(resolveMentionsToText("<@U456> hi", users)).toBe("@Bo Chen hi")
  })

  it("falls back to the raw id for an unknown user, never a generic word", () => {
    expect(resolveMentionsToText("<@U999>", users)).toBe("@U999")
  })

  it("uses the piped label for a group mention when present", () => {
    expect(resolveMentionsToText("ping <!subteam^S1|@platform>", users)).toBe("ping @platform")
  })

  it("adds the @ when the piped group label omits it", () => {
    expect(resolveMentionsToText("<!subteam^S1|platform>", users)).toBe("@platform")
  })

  it("resolves broadcast mentions", () => {
    expect(resolveMentionsToText("<!here> and <!channel> and <!everyone>", users))
      .toBe("@here and @channel and @everyone")
  })

  it("leaves ordinary text and links untouched", () => {
    expect(resolveMentionsToText("see <https://example.com|the docs>", users))
      .toBe("see <https://example.com|the docs>")
  })

  it("returns empty string for undefined input", () => {
    expect(resolveMentionsToText(undefined, users)).toBe("")
  })

  it("still resolves when no users map is available", () => {
    expect(resolveMentionsToText("<@U123> hi", undefined)).toBe("@U123 hi")
  })
})

describe("resolveMentionsToText group directory", () => {
  const groups = { S1: { ID: "S1", Name: "Platform Team", Handle: "platform" } } as never

  it("prefers the group handle, which is what Slack displays", () => {
    expect(resolveMentionsToText("<!subteam^S1>", undefined, groups)).toBe("@platform")
  })

  it("falls back to the group name when there is no handle", () => {
    const noHandle = { S2: { ID: "S2", Name: "Design", Handle: "" } } as never
    expect(resolveMentionsToText("<!subteam^S2>", undefined, noHandle)).toBe("@Design")
  })

  it("falls back to the bare id for an unknown group, never a generic word", () => {
    expect(resolveMentionsToText("<!subteam^S999>", undefined, groups)).toBe("@S999")
  })

  it("still prefers an inline piped label over the directory", () => {
    expect(resolveMentionsToText("<!subteam^S1|@override>", undefined, groups)).toBe("@override")
  })
})
