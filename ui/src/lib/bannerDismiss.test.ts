import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { dismissBanner, isBannerDismissed, useBannerDismissed } from "./bannerDismiss"

beforeEach(() => window.sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("bannerDismiss", () => {
  it("starts undismissed", () => {
    expect(isBannerDismissed("home")).toBe(false)
  })

  it("remembers a dismissal", () => {
    dismissBanner("home")
    expect(isBannerDismissed("home")).toBe(true)
  })

  it("re-renders subscribers when a banner is dismissed", () => {
    const { result } = renderHook(() => useBannerDismissed("home"))
    expect(result.current).toBe(false)
    act(() => dismissBanner("home"))
    expect(result.current).toBe(true)
  })

  it("stores in sessionStorage, so a new tab starts over", () => {
    dismissBanner("home")
    expect(Object.keys(window.sessionStorage).some((k) => k.includes("home"))).toBe(true)
  })

  it("treats a throwing sessionStorage as undismissed rather than blowing up", () => {
    // A private window with site data blocked: touching sessionStorage at all
    // throws. jsdom's Storage is a Proxy that ignores a spy on its methods, so
    // the whole accessor is replaced instead.
    const throwing = () => {
      throw new Error("blocked")
    }
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage")
    Object.defineProperty(window, "sessionStorage", { configurable: true, get: throwing })
    try {
      expect(() => dismissBanner("home")).not.toThrow()
      expect(isBannerDismissed("home")).toBe(false)
    } finally {
      if (original) Object.defineProperty(window, "sessionStorage", original)
    }
  })
})
