import { describe, expect, it } from "vitest"
import type { CmuxBrowserTab, CmuxBrowserTabsResponse } from "../api/types"
import { findResourceTab, tabMatchKey } from "./resourceTab"

const tab = (ws: string, surface: string, url: string, over: Partial<CmuxBrowserTab> = {}): CmuxBrowserTab => ({
  workspaceId: `${ws}-UUID`, workspaceRef: `workspace:${ws}`, workspaceTitle: ws, workspaceSelected: false, surface, url, ...over,
})

const tabs = (...t: CmuxBrowserTab[]): CmuxBrowserTabsResponse => ({ available: true, tabs: t })

describe("tabMatchKey", () => {
  it("reduces a PR url and its subpages to the same key", () => {
    const k = tabMatchKey("pr", "https://github.com/Org/Repo/pull/5")
    expect(k).not.toBeNull()
    expect(tabMatchKey("pr", "https://github.com/org/repo/pull/5/files#diff-1")).toBe(k)
    expect(tabMatchKey("pr", "https://GitHub.com/org/repo/pull/5/?w=1")).toBe(k)
    expect(tabMatchKey("pr", "https://github.com/org/repo/pull/50")).not.toBe(k)
  })

  it("reduces a Jira browse url to its issue key", () => {
    const k = tabMatchKey("jira", "https://acme.atlassian.net/browse/PROJ-12")
    expect(tabMatchKey("jira", "https://acme.atlassian.net/browse/proj-12?focusedCommentId=3")).toBe(k)
    expect(tabMatchKey("jira", "https://acme.atlassian.net/browse/PROJ-123")).not.toBe(k)
  })

  it("is null for other types and unparseable urls", () => {
    expect(tabMatchKey("slack", "https://x.slack.com/archives/C1/p1")).toBeNull()
    expect(tabMatchKey("link", "https://example.com")).toBeNull()
    expect(tabMatchKey("pr", "not a url")).toBeNull()
    expect(tabMatchKey("pr", "https://github.com/org/repo")).toBeNull()
  })
})

describe("findResourceTab", () => {
  const PR = "https://github.com/org/repo/pull/5"
  const key = tabMatchKey("pr", PR)!

  it("finds a tab on the resource in any workspace", () => {
    const res = tabs(tab("B", "surface:1", "https://github.com/org/repo/pull/6"), tab("C", "surface:2", PR + "/files"))
    expect(findResourceTab(res, "pr", key, ["workspace:A"])).toMatchObject({ workspaceRef: "workspace:C", surface: "surface:2" })
  })

  it("prefers the worktree's own workspace, then the selected one", () => {
    const anywhere = tab("B", "surface:1", PR)
    const selected = tab("C", "surface:2", PR, { workspaceSelected: true })
    const own = tab("A", "surface:3", PR)
    expect(findResourceTab(tabs(anywhere, selected, own), "pr", key, ["workspace:A"])).toBe(own)
    expect(findResourceTab(tabs(anywhere, selected), "pr", key, ["workspace:A"])).toBe(selected)
    expect(findResourceTab(tabs(anywhere), "pr", key, [])).toBe(anywhere)
  })

  it("is null when nothing matches or cmux is unavailable", () => {
    expect(findResourceTab(tabs(tab("A", "surface:1", "https://github.com/org/repo/pull/6")), "pr", key, [])).toBeNull()
    expect(findResourceTab({ available: false, tabs: [] }, "pr", key, [])).toBeNull()
    expect(findResourceTab(undefined, "pr", key, [])).toBeNull()
  })
})
