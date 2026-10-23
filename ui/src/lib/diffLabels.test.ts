import { describe, expect, it } from "vitest"
import type { Commit, WorktreeGit } from "../api/types"
import { badgeColor, formatBadge, rangeLabel, unpushedCommits, unpushedLabel } from "./diffLabels"

const commit = (sha: string): Commit => ({ sha, short: sha, subject: sha, author: "a", date: "2026-01-01T00:00:00Z" })
// Newest first, as the server lists them.
const commits = ["c", "b", "a"].map(commit)

const git = (over: Partial<WorktreeGit>): WorktreeGit => ({
  on_disk: true,
  fingerprint: "f",
  working_fingerprint: "w",
  branch: "x",
  working: { staged: 0, modified: 0, untracked: 0, files: 0 },
  fetch: { in_progress: false },
  ...over,
})

describe("unpushedCommits / unpushedLabel", () => {
  it("counts commits ahead of the tracking branch when there is one", () => {
    const g = git({ tracking: "origin/x", vs_tracking: { ahead: 3, behind: 1 }, vs_merge_base: { ahead: 9, behind: 0 } })
    expect(unpushedCommits(g)).toBe(3)
    expect(unpushedLabel(g)).toBe("3 unpushed commits")
  })
  it("counts commits past the merge base for a branch never pushed", () => {
    const g = git({ vs_merge_base: { ahead: 1, behind: 4 } })
    expect(unpushedCommits(g)).toBe(1)
    expect(unpushedLabel(g)).toBe("1 unpushed commit")
  })
  it("is zero, with no label, when everything is pushed or nothing is known", () => {
    expect(unpushedLabel(git({ tracking: "origin/x", vs_tracking: { ahead: 0, behind: 2 }, vs_merge_base: { ahead: 5, behind: 0 } }))).toBeNull()
    expect(unpushedCommits(git({}))).toBe(0)
    expect(unpushedLabel(git({}))).toBeNull()
  })
})

describe("badgeColor", () => {
  const dirty = { staged: 0, modified: 2, untracked: 0, files: 2 }
  const pushed = { tracking: "origin/x", vs_tracking: { ahead: 0, behind: 3 }, vs_merge_base: { ahead: 4, behind: 0 } }
  const unpushed = { tracking: "origin/x", vs_tracking: { ahead: 2, behind: 0 }, vs_merge_base: { ahead: 4, behind: 0 } }

  it("is gray when clean and pushed", () => {
    expect(badgeColor(git(pushed))).toBe("gray")
  })
  it("is orange with unpushed commits", () => {
    expect(badgeColor(git(unpushed))).toBe("orange")
  })
  it("is yellow with uncommitted changes", () => {
    expect(badgeColor(git({ ...pushed, working: dirty }))).toBe("yellow")
  })
  it("is yellow when both apply: uncommitted changes are the stronger warning", () => {
    expect(badgeColor(git({ ...unpushed, working: dirty }))).toBe("yellow")
  })
  it("is orange for a branch never pushed with commits past the merge base", () => {
    expect(badgeColor(git({ vs_merge_base: { ahead: 1, behind: 0 } }))).toBe("orange")
  })
  it("is gray for a branch never pushed with nothing past the merge base", () => {
    expect(badgeColor(git({ vs_merge_base: { ahead: 0, behind: 5 } }))).toBe("gray")
  })
})

describe("formatBadge", () => {
  it("shows ahead, behind and changed files", () => {
    const g = git({ vs_merge_base: { ahead: 8, behind: 12 }, working: { staged: 1, modified: 2, untracked: 1, files: 4 } })
    expect(formatBadge(g, "merge-base")).toBe("↑8 ↓12 · 4")
  })
  it("omits the file count when zero", () => {
    expect(formatBadge(git({ vs_merge_base: { ahead: 3, behind: 0 } }), "merge-base")).toBe("↑3 ↓0")
  })
  it("uses the counts for the chosen base", () => {
    const g = git({ vs_merge_base: { ahead: 1, behind: 1 }, vs_tracking: { ahead: 5, behind: 0 } })
    expect(formatBadge(g, "tracking")).toBe("↑5 ↓0")
  })
  it("is null when everything is zero or absent", () => {
    expect(formatBadge(git({}), "merge-base")).toBeNull()
    expect(formatBadge(git({ vs_tracking: { ahead: 0, behind: 0 } }), "tracking")).toBeNull()
  })
})

describe("rangeLabel", () => {
  it("labels the all range", () => {
    expect(rangeLabel(commits, "all")).toBe("All changes")
  })
  it("labels only uncommitted", () => {
    expect(rangeLabel(commits, { from: "uncommitted", to: "uncommitted" })).toBe("Uncommitted changes")
  })
  it("labels single and partial runs", () => {
    expect(rangeLabel(commits, { from: "b", to: "b" })).toBe("1 commit")
    expect(rangeLabel(commits, { from: "b", to: "c" })).toBe("2 of 3 commits")
  })
  it("appends + uncommitted when included", () => {
    expect(rangeLabel(commits, { from: "c", to: "uncommitted" })).toBe("1 commit + uncommitted")
    expect(rangeLabel(commits, { from: "b", to: "uncommitted" })).toBe("2 of 3 commits + uncommitted")
  })
  it("a full run equals All commits / All changes", () => {
    expect(rangeLabel(commits, { from: "a", to: "c" })).toBe("All commits")
    expect(rangeLabel(commits, { from: "a", to: "uncommitted" })).toBe("All changes")
  })
  it("a single-commit list is fully covered by that commit", () => {
    expect(rangeLabel([commit("a")], { from: "a", to: "uncommitted" })).toBe("All changes")
    expect(rangeLabel([commit("a")], { from: "a", to: "a" })).toBe("All commits")
  })
  it("falls back to All changes for a range naming unknown commits", () => {
    expect(rangeLabel(commits, { from: "zzz", to: "c" })).toBe("All changes")
  })
})
