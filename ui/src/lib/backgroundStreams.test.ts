import { afterEach, describe, expect, it } from "vitest"
import { streamsPauseWhenHidden } from "./backgroundStreams"

afterEach(() => {
  delete window.webkit
})

describe("streamsPauseWhenHidden", () => {
  it("pauses over plain HTTP in a browser", () => {
    expect(window.location.protocol).toBe("http:")
    expect(streamsPauseWhenHidden()).toBe(true)
  })

  it("never pauses in the macOS menu bar app, which is hidden while its dropdown is closed", () => {
    window.webkit = { messageHandlers: { worktree: { postMessage: () => {} } } }
    expect(streamsPauseWhenHidden()).toBe(false)
  })
})
