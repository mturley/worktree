import { describe, it, expect } from "vitest"
import { slackResourceIdForUrl } from "./trackedThread"

// Real id shapes from the user's database.
describe("slackResourceIdForUrl", () => {
  it("matches a thread-root permalink", () => {
    expect(slackResourceIdForUrl("https://redhat.enterprise.slack.com/archives/C069KSM8T9N/p1786711632753269"))
      .toBe("C069KSM8T9N:1786711632.753269")
  })

  it("uses thread_ts when the link points at a reply", () => {
    expect(slackResourceIdForUrl(
      "https://redhat.enterprise.slack.com/archives/C069KSM8T9N/p1787585999000100?thread_ts=1787585945.962369&cid=C069KSM8T9N"))
      .toBe("C069KSM8T9N:1787585945.962369")
  })

  it("handles cid before thread_ts in the query string", () => {
    expect(slackResourceIdForUrl(
      "https://redhat.enterprise.slack.com/archives/C069KSM8T9N/p1787585999000100?cid=C069KSM8T9N&thread_ts=1787585945.962369"))
      .toBe("C069KSM8T9N:1787585945.962369")
  })

  it("tolerates a trailing slash or extra path segment", () => {
    expect(slackResourceIdForUrl("https://x.slack.com/archives/C1/p1700000000000100/"))
      .toBe("C1:1700000000.000100")
  })

  it("returns null for a non-thread url", () => {
    expect(slackResourceIdForUrl("https://example.com/whatever")).toBeNull()
  })
})
