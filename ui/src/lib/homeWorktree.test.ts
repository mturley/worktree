import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import {
  captureHomeWorktree,
  getHomeWorktree,
  homeWorktreeHref,
  shouldShowHomeBanner,
  withHomeParam,
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
  it("records the worktree a marked URL was opened for", () => {
    at(`/worktree/${encodeURIComponent(WT)}?home=${encodeURIComponent(WT)}`)
    expect(captureHomeWorktree()).toBe(WT)
    expect(getHomeWorktree()).toBe(WT)
  })

  it("LEAVES the parameter in the URL", () => {
    // The whole point of the redesign: a cmux pane that sleeps and restores
    // comes back with a URL and nothing else, so the URL has to keep it.
    at(`/worktree/${encodeURIComponent(WT)}?home=${encodeURIComponent(WT)}`)
    captureHomeWorktree()
    expect(new URLSearchParams(window.location.search).get("home")).toBe(WT)
  })

  it("re-attaches the parameter when a tab that knows its home loses it", () => {
    at(`/?home=${encodeURIComponent(WT)}`)
    captureHomeWorktree()
    at("/")
    expect(captureHomeWorktree()).toBe(WT)
    expect(new URLSearchParams(window.location.search).get("home")).toBe(WT)
  })

  it("keeps other query parameters when re-attaching", () => {
    at(`/?home=${encodeURIComponent(WT)}`)
    captureHomeWorktree()
    at("/worktree/x?resource=pr%3Ao%2Fr%231")
    captureHomeWorktree()
    const q = new URLSearchParams(window.location.search)
    expect(q.get("resource")).toBe("pr:o/r#1")
    expect(q.get("home")).toBe(WT)
  })

  it("leaves an unhomed tab alone", () => {
    at("/")
    expect(captureHomeWorktree()).toBeNull()
    expect(window.location.search).toBe("")
  })

  it("re-homes the tab when a later URL names a different worktree", () => {
    at(`/?home=${encodeURIComponent(WT)}`)
    captureHomeWorktree()
    const other = "/Users/me/.worktrees/repo/other"
    at(`/worktree/x?home=${encodeURIComponent(other)}`)
    expect(captureHomeWorktree()).toBe(other)
  })

  it("survives sessionStorage throwing, because the URL still carries it", () => {
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    at(`/worktree/x?home=${encodeURIComponent(WT)}`)
    expect(captureHomeWorktree()).toBe(WT)
    expect(getHomeWorktree()).toBe(WT)
  })
})

describe("withHomeParam", () => {
  it("adds the home to a destination", () => {
    at(`/?home=${encodeURIComponent(WT)}`)
    captureHomeWorktree()
    expect(withHomeParam("/")).toBe(`/?home=${encodeURIComponent(WT)}`)
  })

  it("preserves a destination's own query", () => {
    at(`/?home=${encodeURIComponent(WT)}`)
    captureHomeWorktree()
    const got = new URLSearchParams(withHomeParam("/worktree/x?resource=pr%3A1").split("?")[1])
    expect(got.get("resource")).toBe("pr:1")
    expect(got.get("home")).toBe(WT)
  })

  it("does not duplicate a home that is already right", () => {
    at(`/?home=${encodeURIComponent(WT)}`)
    captureHomeWorktree()
    const to = `/x?home=${encodeURIComponent(WT)}`
    expect(withHomeParam(to)).toBe(to)
  })

  it("is a no-op in a tab with no home", () => {
    at("/")
    expect(withHomeParam("/worktree/x")).toBe("/worktree/x")
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
