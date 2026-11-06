import { afterEach, describe, expect, it } from "vitest"
import { cleanup, renderHook } from "@testing-library/react"
import { setViewport } from "../testing/viewport"
import { useMiniModalFullScreen } from "./useMiniModalFullScreen"

afterEach(() => {
  window.history.replaceState({}, "", "/")
  setViewport("narrow")
  cleanup()
})

describe("useMiniModalFullScreen", () => {
  it("fills a narrow mini view", () => {
    window.history.replaceState({}, "", "/mini")
    setViewport("narrow")
    expect(renderHook(() => useMiniModalFullScreen()).result.current).toBe(true)
  })

  it("opens windowed in a wide mini view", () => {
    window.history.replaceState({}, "", "/mini")
    setViewport("wide")
    expect(renderHook(() => useMiniModalFullScreen()).result.current).toBe(false)
  })

  it("never fills the full UI", () => {
    setViewport("narrow")
    expect(renderHook(() => useMiniModalFullScreen()).result.current).toBe(false)
  })
})
