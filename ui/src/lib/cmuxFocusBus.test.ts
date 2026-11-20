import { describe, it, expect, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { emitCmuxFocus, lastCmuxFocus, onCmuxFocus, recordCmuxFocus, useLastCmuxFocus } from "./cmuxFocusBus"

const msg = (workspace_id: string, path = "") => ({ workspace_id, path, title: workspace_id, color: "" })

describe("cmuxFocusBus", () => {
  it("starts with nothing seen", () => {
    expect(lastCmuxFocus()).toBeNull()
  })

  it("remembers the last message emitted, for subscribers that came later", () => {
    act(() => emitCmuxFocus(msg("W1", "/wt/a")))
    const { result } = renderHook(useLastCmuxFocus)
    expect(result.current?.workspace_id).toBe("W1")
    act(() => emitCmuxFocus(msg("W2")))
    expect(result.current?.workspace_id).toBe("W2")
  })

  it("records a message without handing it to the follower", () => {
    const listener = vi.fn()
    const off = onCmuxFocus(listener)
    act(() => recordCmuxFocus(msg("W3")))
    off()
    expect(listener).not.toHaveBeenCalled()
    expect(lastCmuxFocus()?.workspace_id).toBe("W3")
  })
})
