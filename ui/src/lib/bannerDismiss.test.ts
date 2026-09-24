import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { dismissBanner, isBannerDismissed } from "./bannerDismiss"

beforeEach(() => window.sessionStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("bannerDismiss", () => {
  it("starts undismissed", () => {
    expect(isBannerDismissed("home")).toBe(false)
    expect(isBannerDismissed("all")).toBe(false)
  })

  it("remembers a dismissal", () => {
    dismissBanner("home")
    expect(isBannerDismissed("home")).toBe(true)
  })

  it("keeps the two banners independent", () => {
    // They are mutually exclusive on any one route, but a tab can outlive the
    // condition that chose between them — a dismissal must not carry over.
    dismissBanner("home")
    expect(isBannerDismissed("all")).toBe(false)
  })

  it("stores in sessionStorage, so a new tab starts over", () => {
    dismissBanner("all")
    expect(Object.keys(window.sessionStorage).some((k) => k.includes("all"))).toBe(true)
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
