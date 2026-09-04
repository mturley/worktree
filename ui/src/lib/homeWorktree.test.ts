import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import {
  captureHomeWorktree,
  getHomeWorktree,
  homeWorktreeHref,
  shouldShowHomeBanner,
  worktreeName,
} from "./homeWorktree"

const WT = "/Users/me/.worktrees/repo/my-branch"

beforeEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState({}, "", "/")
})
afterEach(() => vi.restoreAllMocks())

/** Puts the browser at a URL the server would have opened. */
function at(path: string) {
  window.history.replaceState({}, "", path)
}

describe("captureHomeWorktree", () => {
  it("records the worktree a marked detail URL was opened for", () => {
    at(`/worktree/${encodeURIComponent(WT)}?home=1`)
    expect(captureHomeWorktree()).toBe(WT)
    expect(getHomeWorktree()).toBe(WT)
  })

  it("strips the marker so a copied link cannot re-home another tab", () => {
    at(`/worktree/${encodeURIComponent(WT)}?home=1`)
    captureHomeWorktree()
    expect(window.location.search).toBe("")
    // And the path itself survives intact — stripping one param must not
    // rewrite the route.
    expect(decodeURIComponent(window.location.pathname)).toBe(`/worktree/${WT}`)
  })

  it("keeps other query parameters", () => {
    at(`/worktree/${encodeURIComponent(WT)}?home=1&resource=pr%3Ao%2Fr%231`)
    captureHomeWorktree()
    expect(window.location.search).toBe("?resource=pr%3Ao%2Fr%231")
  })

  it("ignores an unmarked URL, leaving any existing home alone", () => {
    at(`/worktree/${encodeURIComponent(WT)}?home=1`)
    captureHomeWorktree()
    at("/")
    expect(captureHomeWorktree()).toBe(WT)
  })

  it("does not home a tab opened at the listing page", () => {
    // The server never marks "/" — it was opened for nothing.
    at("/?home=1")
    expect(captureHomeWorktree()).toBeNull()
  })

  it("re-homes the tab when a later marked URL arrives", () => {
    at(`/worktree/${encodeURIComponent(WT)}?home=1`)
    captureHomeWorktree()
    const other = "/Users/me/.worktrees/repo/other"
    at(`/worktree/${encodeURIComponent(other)}?home=1`)
    expect(captureHomeWorktree()).toBe(other)
  })

  it("survives sessionStorage throwing", () => {
    // Private windows with site data blocked throw on ACCESS, not just on
    // write. A missing banner is fine; a blank page is not.
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    at(`/worktree/${encodeURIComponent(WT)}?home=1`)
    expect(() => captureHomeWorktree()).not.toThrow()
  })
})

describe("shouldShowHomeBanner", () => {
  it("hides on the home worktree's own detail page", () => {
    expect(shouldShowHomeBanner(WT, `/worktree/${encodeURIComponent(WT)}`)).toBe(false)
  })

  it("shows on the listing and on other worktrees", () => {
    expect(shouldShowHomeBanner(WT, "/")).toBe(true)
    expect(shouldShowHomeBanner(WT, "/worktree/%2Fsomewhere%2Felse")).toBe(true)
  })

  it("shows nothing in a tab that was never homed", () => {
    expect(shouldShowHomeBanner(null, "/")).toBe(false)
  })

  it("treats a malformed path as somewhere else rather than throwing", () => {
    expect(() => shouldShowHomeBanner(WT, "/worktree/%")).not.toThrow()
    expect(shouldShowHomeBanner(WT, "/worktree/%")).toBe(true)
  })
})

describe("naming and links", () => {
  it("names a worktree by its own directory", () => {
    expect(worktreeName(WT)).toBe("my-branch")
    expect(worktreeName("/trailing/slash/")).toBe("slash")
  })

  it("round-trips a path through the route it builds", () => {
    const href = homeWorktreeHref(WT)
    expect(shouldShowHomeBanner(WT, href)).toBe(false)
  })
})
