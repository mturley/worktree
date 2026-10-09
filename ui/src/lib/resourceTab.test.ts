import { describe, expect, it } from "vitest"
import type { CmuxTab, CmuxTreeResponse, CmuxTreeWorkspace } from "../api/types"
import { findResourceTab, tabMatchKey } from "./resourceTab"

const tab = (ref: string, url?: string, over: Partial<CmuxTab> = {}): CmuxTab => ({
  ref, title: ref, type: url ? "browser" : "terminal", url, selected: false, ...over,
})

function ws(id: string, tabs: CmuxTab[], over: Partial<CmuxTreeWorkspace> = {}): CmuxTreeWorkspace {
  return { id, ref: `workspace:${id}`, title: id, selected: false, panes: [{ ref: "pane:1", focused: true, tabs }], ...over }
}

const tree = (...workspaces: CmuxTreeWorkspace[]): CmuxTreeResponse => ({ available: true, workspaces })

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

  it("finds a browser tab on the resource, ignoring terminals", () => {
    const t = tree(ws("A", [tab("surface:1"), tab("surface:2", "https://github.com/org/repo/pull/5/files")]))
    expect(findResourceTab(t, "pr", key)).toMatchObject({ workspace: { id: "A" }, tab: { ref: "surface:2" } })
  })

  it("prefers a match in the selected workspace", () => {
    const t = tree(ws("A", [tab("surface:1", PR)]), ws("B", [tab("surface:9", PR)], { selected: true }))
    expect(findResourceTab(t, "pr", key)).toMatchObject({ workspace: { id: "B" }, tab: { ref: "surface:9" } })
  })

  it("is null when nothing matches, cmux is unavailable, or a tree failed to load", () => {
    expect(findResourceTab(tree(ws("A", [tab("surface:1", "https://github.com/org/repo/pull/6")])), "pr", key)).toBeNull()
    expect(findResourceTab({ available: false, workspaces: [] }, "pr", key)).toBeNull()
    expect(findResourceTab(undefined, "pr", key)).toBeNull()
    expect(findResourceTab(tree({ id: "A", ref: "workspace:1", title: "A", selected: false, error: "boom" }), "pr", key)).toBeNull()
  })
})
