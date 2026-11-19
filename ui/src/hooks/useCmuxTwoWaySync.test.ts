import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { act, renderHook } from "@testing-library/react"
import {
  CMUX_TWO_WAY_SYNC_KEY,
  isCmuxTwoWaySync,
  setCmuxTwoWaySync,
  useCmuxTwoWaySync,
} from "./useCmuxTwoWaySync"
import { FOLLOW_CMUX_KEY, setFollowCmux } from "./useFollowCmux"

beforeEach(() => window.sessionStorage.clear())
afterEach(() => {
  act(() => setCmuxTwoWaySync(false))
  act(() => setFollowCmux(false))
})

describe("useCmuxTwoWaySync", () => {
  it("defaults to off", () => {
    const { result } = renderHook(useCmuxTwoWaySync)
    expect(result.current[0]).toBe(false)
  })

  it("persists to sessionStorage under its own key", () => {
    act(() => setCmuxTwoWaySync(true))
    expect(CMUX_TWO_WAY_SYNC_KEY).toBe("worktree.cmuxTwoWaySync")
    expect(window.sessionStorage.getItem("worktree.cmuxTwoWaySync")).toBe("true")
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBeNull()
  })

  it("re-renders subscribers", () => {
    const { result } = renderHook(useCmuxTwoWaySync)
    act(() => setCmuxTwoWaySync(true))
    expect(result.current[0]).toBe(true)
  })

  it("is independent of following", () => {
    act(() => setCmuxTwoWaySync(true))
    act(() => setFollowCmux(false))
    expect(isCmuxTwoWaySync()).toBe(true)
  })
})
