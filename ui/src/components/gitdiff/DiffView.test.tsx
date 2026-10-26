import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DiffCommits, DiffPatch, ReviewCommentItem, ViewStatus, WorktreeGit } from "../../api/types"
import { setViewport } from "../../testing/viewport"

// pierre renders into shadow DOM, which tests can't see into: stand the body
// in with what it was given.
vi.mock("./DiffBody", () => ({
  DiffBody: (p: {
    files: { path: string }[]
    mode: string
    highlighted: string | null
    comments: { id: number }[]
    openFile: { file: string; n: number } | null
    onStartComment: (t: { file: string; side: "new"; start: number; end: number }) => void
    onPendingDone: () => void
  }) => (
    <div
      data-testid="diff-body"
      data-mode={p.mode}
      data-highlighted={p.highlighted ?? ""}
      data-comments={p.comments.map((c) => c.id).join(",")}
      data-open-file={p.openFile?.file ?? ""}
    >
      {p.files.map((f) => f.path).join(",")}
      <button onClick={() => p.onStartComment({ file: "a.go", side: "new", start: 1, end: 1 })}>start comment</button>
      <button onClick={p.onPendingDone}>end comment</button>
    </div>
  ),
}))

// Scrolling is scrollToFile's (tested on its own); here, only that it is asked.
const scrollMock = vi.hoisted(() => ({ scrollToFile: vi.fn(() => () => {}), scrollToComment: vi.fn(() => () => {}) }))
vi.mock("./scrollToFile", () => ({
  DIFF_SCROLLER_CLASS: "diff-body-scroller",
  scrollToFile: scrollMock.scrollToFile,
  scrollToComment: scrollMock.scrollToComment,
}))

const gitMock = vi.hoisted(() => ({ value: undefined as WorktreeGit | undefined }))
vi.mock("../../hooks/useWorktreeGit", () => ({
  useWorktreeGit: () => ({ data: gitMock.value }),
}))

const apiMock = vi.hoisted(() => ({
  listId: "L1",
  commits: [] as DiffCommits["commits"],
  patches: [] as DiffPatch[],
  diffPatch: vi.fn(),
  diffCommits: vi.fn(),
  reviewComments: vi.fn(),
}))
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      settings: async () => ({ worktree: { editor: "code" } }),
      diffCommits: apiMock.diffCommits,
      diffPatch: apiMock.diffPatch,
      reviewComments: apiMock.reviewComments,
    },
  }
})

import { HttpError } from "../../api/client"
import { editDraftKey, useDeletedDrafts, useEditorDraft } from "../../hooks/useReviewComments"
import { setReviewSidebar } from "../../hooks/useReviewSidebar"
import DiffView from "./DiffView"

const PATCH = (file: string) => `diff --git a/${file} b/${file}
index 1111111..2222222 100644
--- a/${file}
+++ b/${file}
@@ -1,2 +1,2 @@
 a
-b
+c
`

const git = (over: Partial<WorktreeGit> = {}): WorktreeGit => ({
  on_disk: true,
  fingerprint: "F1",
  working_fingerprint: "W1",
  branch: "feat",
  main_upstream: "upstream/main",
  merge_base: "mb",
  vs_merge_base: { ahead: 1, behind: 0 },
  working: { staged: 0, modified: 1, untracked: 0, files: 1 },
  fetch: { in_progress: false },
  ...over,
})

const commits = (): DiffCommits => ({
  list_id: apiMock.listId,
  base_ref: "upstream/main",
  merge_base: "mb",
  commits: apiMock.commits,
})
const commit = (sha: string) => ({ sha, short: sha, subject: `subject ${sha}`, author: "me", date: "2026-10-01T00:00:00Z" })

const comment = (id: number, status: ViewStatus, over: Partial<ReviewCommentItem> = {}): ReviewCommentItem => ({
  id,
  source: "draft",
  editable: true,
  file: "a.go",
  side: "new",
  start_line: id,
  end_line: id,
  rev: "uncommitted",
  base: "merge-base",
  base_ref: "upstream/main",
  snippet: ["x"],
  body: `body ${id}`,
  version: 1,
  created_at: "",
  updated_at: "",
  prompt: { status: "current", start_line: id, end_line: id },
  view: { status, start_line: id, end_line: id },
  ...over,
})
/** Answers the comment list with what `byRev` gives for the view's new rev. */
const listComments = (byRev: (newRev: string | undefined) => ReviewCommentItem[]) =>
  apiMock.reviewComments.mockImplementation(async (_p: string, v?: { newRev: string }) => ({ comments: byRev(v?.newRev) }))
const refetchComments = () => act(() => client.invalidateQueries({ queryKey: ["review-comments"] }))

const patch = (over: Partial<DiffPatch> = {}): DiffPatch => ({
  list_id: "L1",
  working_fingerprint: "W1",
  old_rev: "mb",
  new_rev: "snap",
  patch: PATCH("a.go"),
  ...over,
})

const tree = (props: { escHint?: boolean } = {}) => (
  <MantineProvider>
    <QueryClientProvider client={client}>
      <DiffView path="/wt/foo" headerHeight={100} {...props} />
    </QueryClientProvider>
  </MantineProvider>
)
let client: QueryClient

const setup = (props: { escHint?: boolean } = {}) => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(tree(props))
}

beforeEach(() => {
  setViewport("wide")
  window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?diff`)
  window.localStorage.clear()
  gitMock.value = git()
  apiMock.listId = "L1"
  apiMock.commits = [commit("c1")]
  apiMock.patches = [patch()]
  scrollMock.scrollToFile.mockClear()
  apiMock.diffPatch.mockReset()
  apiMock.diffPatch.mockImplementation(async () => apiMock.patches.shift() ?? patch())
  apiMock.diffCommits.mockReset()
  apiMock.diffCommits.mockImplementation(async () => commits())
  apiMock.reviewComments.mockReset()
  apiMock.reviewComments.mockImplementation(async () => ({ comments: [] }))
  scrollMock.scrollToComment.mockClear()
  window.sessionStorage.clear()
})
afterEach(cleanup)

describe("DiffView", () => {
  it("loads the patch for the current selection and renders its files", async () => {
    setup()
    expect(await screen.findByTestId("diff-body")).toHaveTextContent("a.go")
    expect(apiMock.diffPatch).toHaveBeenCalledWith("/wt/foo", "merge-base", "all", false)
    expect(screen.getByText("1 file changed")).toBeInTheDocument()
  })

  it("shows the commit list's error instead of loading forever", async () => {
    apiMock.diffCommits.mockImplementation(async () => {
      throw new Error("bad revision")
    })
    setup()
    expect(await screen.findByText(/Could not load changes against upstream\/main: bad revision/)).toBeInTheDocument()
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
    expect(apiMock.diffPatch).not.toHaveBeenCalled()
  })

  it("hides the Refresh notice while what it shows is current", async () => {
    setup()
    await screen.findByTestId("diff-body")
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument()
  })

  it("offers Refresh when the working tree changes under an uncommitted selection", async () => {
    const { rerender } = setup()
    await screen.findByTestId("diff-body")
    gitMock.value = git({ fingerprint: "F2", working_fingerprint: "W2" })
    rerender(tree())
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeInTheDocument()
    // Pinned: nothing reloads on its own.
    expect(apiMock.diffPatch).toHaveBeenCalledTimes(1)
  })

  it("does not offer Refresh when only upstream/main moves", async () => {
    const { rerender } = setup()
    await screen.findByTestId("diff-body")
    // A fetch moves the fingerprint (behind count) but not the list or the
    // working tree; the commit list refetches and comes back the same.
    gitMock.value = git({ fingerprint: "F2", vs_merge_base: { ahead: 1, behind: 5 } })
    rerender(tree())
    await waitFor(() => expect(apiMock.diffCommits).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument()
  })

  it("offers Refresh when the commit list changes", async () => {
    const { rerender } = setup()
    await screen.findByTestId("diff-body")
    apiMock.listId = "L2"
    gitMock.value = git({ fingerprint: "F2" })
    rerender(tree())
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeInTheDocument()
  })

  it("does not offer Refresh for a working-tree change when the selection has no uncommitted changes", async () => {
    window.localStorage.setItem(
      "worktree.diffSelection:/wt/foo",
      JSON.stringify({ base: "merge-base", range: { from: "c1", to: "c1" }, listId: "L1" }),
    )
    const { rerender } = setup()
    await screen.findByTestId("diff-body")
    expect(apiMock.diffPatch).toHaveBeenCalledWith("/wt/foo", "merge-base", { from: "c1", to: "c1" }, false)
    gitMock.value = git({ fingerprint: "F2", working_fingerprint: "W2" })
    rerender(tree())
    await waitFor(() => expect(apiMock.diffCommits).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument()
  })

  it("labels the selectors with the pinned selection while stale, then the live one after Refresh", async () => {
    apiMock.commits = [commit("c2"), commit("c1")]
    window.localStorage.setItem(
      "worktree.diffSelection:/wt/foo",
      JSON.stringify({ base: "merge-base", range: { from: "c1", to: "c1" }, listId: "L1" }),
    )
    const { rerender } = setup()
    await screen.findByTestId("diff-body")
    expect(screen.getByTestId("range-picker-trigger")).toHaveTextContent("1 commit")
    // A rebase: c1 is gone from the live list, which resets the live range.
    apiMock.listId = "L2"
    apiMock.commits = [commit("c3")]
    gitMock.value = git({ fingerprint: "F2" })
    rerender(tree())
    await screen.findByRole("button", { name: "Refresh" })
    expect(screen.getByTestId("range-picker-trigger")).toHaveTextContent("1 commit")
    apiMock.patches = [patch({ list_id: "L2" })]
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument())
    expect(apiMock.diffPatch).toHaveBeenLastCalledWith("/wt/foo", "merge-base", "all", false)
    expect(screen.getByTestId("range-picker-trigger")).toHaveTextContent("All changes")
  })

  it("reloads the patch on Refresh, and the notice clears", async () => {
    const { rerender } = setup()
    await screen.findByTestId("diff-body")
    apiMock.patches = [patch({ working_fingerprint: "W2", patch: PATCH("b.go") })]
    gitMock.value = git({ fingerprint: "F2", working_fingerprint: "W2" })
    rerender(tree())
    await userEvent.click(await screen.findByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(screen.getByTestId("diff-body")).toHaveTextContent("b.go"))
    expect(apiMock.diffPatch).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument()
  })

  it("reloads immediately when the selection changes", async () => {
    setup()
    await screen.findByTestId("diff-body")
    await userEvent.click(screen.getByTestId("range-picker-trigger"))
    await userEvent.click(await screen.findByRole("button", { name: "Uncommitted changes" }))
    await waitFor(() =>
      expect(apiMock.diffPatch).toHaveBeenLastCalledWith(
        "/wt/foo",
        "merge-base",
        { from: "uncommitted", to: "uncommitted" },
        false,
      ),
    )
  })

  it("reloads immediately when whitespace is hidden", async () => {
    setup()
    await screen.findByTestId("diff-body")
    await userEvent.click(screen.getByRole("switch", { name: "Hide whitespace" }))
    await waitFor(() => expect(apiMock.diffPatch).toHaveBeenLastCalledWith("/wt/foo", "merge-base", "all", true))
  })

  it("goes back to the worktree from the breadcrumb", async () => {
    setup()
    await screen.findByTestId("diff-body")
    const crumb = document.querySelector("[data-diff-breadcrumb]")!
    // Esc's hint sits beside the link that does the same (wide only).
    expect(crumb.textContent).toMatch(/^← Worktree details(Esc)?\/Changes \(feat\)$/)
    expect(crumb.textContent).not.toMatch(/go back/)
    await userEvent.click(screen.getByRole("button", { name: "← Worktree details" }))
    expect(new URLSearchParams(window.location.search).has("diff")).toBe(false)
  })

  it("drops the breadcrumb's Esc hint when Esc's next step is the page's", async () => {
    setup({ escHint: false })
    await screen.findByTestId("diff-body")
    expect(document.querySelector("[data-diff-breadcrumb] kbd")).toBeNull()
  })

  it("highlights the file named in the URL", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?diff&file=a.go`)
    setup()
    await waitFor(() => expect(screen.getByTestId("diff-body")).toHaveAttribute("data-highlighted", "a.go"))
    expect(scrollMock.scrollToFile).toHaveBeenCalledTimes(1)
    expect(scrollMock.scrollToFile).toHaveBeenCalledWith("a.go")
  })

  it("highlights a file picked in the tree", async () => {
    apiMock.patches = [patch({ patch: PATCH("a.go") + PATCH("b.go") })]
    setup()
    await screen.findByTestId("diff-body")
    await userEvent.click(screen.getByTestId("tree-file-b.go"))
    expect(screen.getByTestId("diff-body")).toHaveAttribute("data-highlighted", "b.go")
    expect(scrollMock.scrollToFile).toHaveBeenLastCalledWith("b.go")
  })

  it("filters the tree", async () => {
    apiMock.patches = [patch({ patch: PATCH("a.go") + PATCH("b.go") })]
    setup()
    await screen.findByTestId("diff-body")
    await userEvent.type(screen.getByPlaceholderText("Filter files"), "b.")
    expect(screen.queryByTestId("tree-file-a.go")).not.toBeInTheDocument()
    expect(screen.getByTestId("tree-file-b.go")).toBeInTheDocument()
  })

  it("remembers split or unified", async () => {
    setup()
    await screen.findByTestId("diff-body")
    expect(screen.getByTestId("diff-body")).toHaveAttribute("data-mode", "split")
    await userEvent.click(screen.getByText("Unified"))
    expect(screen.getByTestId("diff-body")).toHaveAttribute("data-mode", "unified")
    expect(window.localStorage.getItem("worktree.diffMode")).toBe("unified")
  })

  it("forces unified when narrow", async () => {
    setViewport("narrow")
    setup()
    expect(await screen.findByTestId("diff-body")).toHaveAttribute("data-mode", "unified")
  })

  it("collapses the sidebar, moving the selectors into the toolbar, and remembers it", async () => {
    setup()
    await screen.findByTestId("diff-body")
    expect(screen.getByPlaceholderText("Filter files")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }))
    expect(screen.queryByPlaceholderText("Filter files")).not.toBeInTheDocument()
    expect(screen.getByTestId("range-picker-trigger")).toBeInTheDocument()
    expect(window.localStorage.getItem("worktree.diffSidebar")).toBe("collapsed")
  })

  it("hides the review button with no comments", async () => {
    setup()
    await screen.findByTestId("diff-body")
    await waitFor(() => expect(apiMock.reviewComments).toHaveBeenCalledWith("/wt/foo", { oldRev: "mb", newRev: "snap" }))
    expect(screen.queryByRole("button", { name: /Local review comments/ })).not.toBeInTheDocument()
  })

  it("shows Local review comments (2) and toggles the sidebar", async () => {
    listComments(() => [comment(1, "shown"), comment(2, "shown")])
    setup()
    const button = await screen.findByRole("button", { name: "Local review comments (2)" })
    await waitFor(() => expect(screen.getByTestId("diff-body")).toHaveAttribute("data-comments", "1,2"))
    expect(screen.queryByRole("button", { name: "Copy comments for agent" })).not.toBeInTheDocument()
    await userEvent.click(button)
    expect(screen.getByRole("button", { name: "Copy comments for agent" })).toBeInTheDocument()
    expect(window.sessionStorage.getItem("worktree.reviewSidebar")).toBe("true")
    expect(button).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(screen.getByRole("button", { name: "Close review comments" }))
    expect(screen.queryByRole("button", { name: "Copy comments for agent" })).not.toBeInTheDocument()
    await userEvent.click(button)
    await userEvent.click(button)
    expect(screen.queryByRole("button", { name: "Copy comments for agent" })).not.toBeInTheDocument()
  })

  it("sidebar is a drawer when narrow", async () => {
    setViewport("narrow")
    listComments(() => [comment(1, "shown")])
    setup()
    await userEvent.click(await screen.findByRole("button", { name: "Local review comments (1)" }))
    const drawer = await screen.findByRole("dialog", { name: "Local review comments" })
    expect(within(drawer).getByRole("button", { name: "Copy comments for agent" })).toBeInTheDocument()
    expect(within(drawer).queryByRole("button", { name: "Close review comments" })).not.toBeInTheDocument()
  })

  it("jumps to a shown comment", async () => {
    listComments(() => [comment(3, "shown")])
    window.sessionStorage.setItem("worktree.reviewSidebar", "true")
    setup()
    await userEvent.click(await screen.findByRole("button", { name: "Jump to comment" }))
    expect(scrollMock.scrollToComment).toHaveBeenCalledWith("a.go", 3)
    expect(screen.getByTestId("diff-body")).toHaveAttribute("data-open-file", "a.go")
  })

  it("jump to a not-in-view comment switches to All changes for its base", async () => {
    gitMock.value = git({ tracking: "origin/feat" })
    listComments((rev) => [comment(4, rev === "snap2" ? "shown" : "not_in_view", { base: "tracking" })])
    apiMock.patches = [patch(), patch({ new_rev: "snap2" })]
    window.sessionStorage.setItem("worktree.reviewSidebar", "true")
    setup()
    await screen.findByText("Not in this view")
    await userEvent.click(screen.getByRole("button", { name: "Jump to comment" }))
    await waitFor(() => expect(apiMock.diffPatch).toHaveBeenLastCalledWith("/wt/foo", "tracking", "all", false))
    await waitFor(() => expect(scrollMock.scrollToComment).toHaveBeenCalledWith("a.go", 4))
    expect(scrollMock.scrollToComment).toHaveBeenCalledTimes(1)
  })

  it("jump disabled for outside the changes", async () => {
    listComments(() => [comment(5, "outside_changes")])
    window.sessionStorage.setItem("worktree.reviewSidebar", "true")
    setup()
    expect(await screen.findByRole("button", { name: "Jump to comment" })).toBeDisabled()
    expect(screen.getByText("Outside the changes")).toBeInTheDocument()
  })

  it("reports the recheck after Refresh", async () => {
    listComments((rev) =>
      rev === "snap2"
        ? [
            comment(1, "shown"),
            comment(2, "shown"),
            comment(3, "shown", { view: { status: "shown", start_line: 9, end_line: 9, moved: true } }),
            comment(4, "outdated"),
          ]
        : [comment(1, "shown"), comment(2, "shown"), comment(3, "shown"), comment(4, "shown")],
    )
    apiMock.patches = [patch(), patch({ working_fingerprint: "W2", new_rev: "snap2" })]
    const { rerender } = setup()
    await screen.findByRole("button", { name: "Local review comments (4)" })
    expect(screen.queryByTestId("comment-recheck")).not.toBeInTheDocument()
    gitMock.value = git({ fingerprint: "F2", working_fingerprint: "W2" })
    rerender(tree())
    await userEvent.click(await screen.findByRole("button", { name: "Refresh" }))
    expect(await screen.findByTestId("comment-recheck")).toHaveTextContent("2 still match, 1 moved, 1 out of date")
    // Until the next view change.
    await userEvent.click(screen.getByRole("switch", { name: "Hide whitespace" }))
    await waitFor(() => expect(screen.queryByTestId("comment-recheck")).not.toBeInTheDocument())
  })

  it("sidebar closes when the list becomes empty", async () => {
    let list = [comment(1, "shown")]
    listComments(() => list)
    window.sessionStorage.setItem("worktree.reviewSidebar", "true")
    setup()
    await screen.findByRole("button", { name: "Copy comments for agent" })
    await waitFor(() => expect(apiMock.reviewComments).toHaveBeenCalledWith("/wt/foo", { oldRev: "mb", newRev: "snap" }))
    list = []
    await refetchComments()
    await waitFor(() => expect(screen.queryByRole("button", { name: /Local review comments/ })).not.toBeInTheDocument())
    expect(screen.queryByRole("button", { name: "Copy comments for agent" })).not.toBeInTheDocument()
    expect(window.sessionStorage.getItem("worktree.reviewSidebar")).toBe("false")
  })

  it("sidebar keeps a deleted-elsewhere draft until dismissed", async () => {
    let list = [comment(1, "shown")]
    listComments(() => list)
    window.sessionStorage.setItem("worktree.reviewSidebar", "true")
    setup()
    await screen.findByRole("button", { name: "Copy comments for agent" })
    const drafts = renderHook(() => useDeletedDrafts("/wt/foo")).result
    act(() => drafts.current.add({ comment: comment(1, "shown"), text: "typed" }))
    await waitFor(() => expect(apiMock.reviewComments).toHaveBeenCalledWith("/wt/foo", { oldRev: "mb", newRev: "snap" }))
    list = []
    await refetchComments()
    await waitFor(() => expect(screen.getByTestId("diff-body")).toHaveAttribute("data-comments", ""))
    expect(screen.getByRole("button", { name: "Local review comments (1)" })).toBeInTheDocument()
    expect(screen.getByText("Deleted elsewhere")).toBeInTheDocument()
    expect(window.sessionStorage.getItem("worktree.reviewSidebar")).toBe("true")
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: /Local review comments/ })).not.toBeInTheDocument())
    expect(window.sessionStorage.getItem("worktree.reviewSidebar")).toBe("false")
  })

  it("reloads the diff when the comment list reports an unknown rev", async () => {
    apiMock.reviewComments.mockImplementation(async (_p: string, v?: { newRev: string }) => {
      if (!v) return { comments: [] }
      if (v.newRev === "snap") throw new HttpError("unknown rev", 404)
      return { comments: [comment(1, "shown")] }
    })
    apiMock.patches = [patch(), patch({ new_rev: "snap2" })]
    setup()
    expect(await screen.findByRole("button", { name: "Local review comments (1)" })).toBeInTheDocument()
    expect(apiMock.diffPatch).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/unknown rev/)).not.toBeInTheDocument()
  })

  it("reloads the shown view's own request, not a pending selection, on an unknown rev", async () => {
    let expired = false
    apiMock.reviewComments.mockImplementation(async (_p: string, v?: { newRev: string }) => {
      if (v && expired) throw new HttpError("unknown rev", 404)
      return { comments: [] }
    })
    window.localStorage.setItem(
      "worktree.diffSelection:/wt/foo",
      JSON.stringify({ base: "merge-base", range: { from: "c1", to: "c1" }, listId: "L1" }),
    )
    const { rerender } = setup()
    await screen.findByTestId("diff-body")
    await waitFor(() => expect(apiMock.reviewComments).toHaveBeenCalledWith("/wt/foo", { oldRev: "mb", newRev: "snap" }))
    // A rebase resets the live range to "all"; the view stays pinned (stale).
    apiMock.listId = "L2"
    apiMock.commits = [commit("c3")]
    gitMock.value = git({ fingerprint: "F2" })
    rerender(tree())
    await screen.findByRole("button", { name: "Refresh" })
    expired = true
    await refetchComments()
    await waitFor(() => expect(apiMock.diffPatch).toHaveBeenCalledTimes(2))
    expect(apiMock.diffPatch).toHaveBeenLastCalledWith("/wt/foo", "merge-base", { from: "c1", to: "c1" }, false)
  })

  it("does not reload on an unknown rev while a comment is edited, and does once it closes", async () => {
    let expired = false
    let refused = 0
    apiMock.reviewComments.mockImplementation(async (_p: string, v?: { newRev: string }) => {
      if (v && expired) {
        refused++
        throw new HttpError("unknown rev", 404)
      }
      return { comments: [comment(1, "shown")] }
    })
    setup()
    await screen.findByRole("button", { name: "Local review comments (1)" })
    await waitFor(() => expect(apiMock.reviewComments).toHaveBeenCalledWith("/wt/foo", { oldRev: "mb", newRev: "snap" }))
    const edit = renderHook(() => useEditorDraft("/wt/foo", editDraftKey("inline", 1))).result
    act(() => edit.current[1]({ text: "typing", baseVersion: 1 }))
    expired = true
    await refetchComments()
    await waitFor(() => expect(refused).toBe(1))
    await act(async () => {})
    expect(apiMock.diffPatch).toHaveBeenCalledTimes(1)
    act(() => edit.current[1](undefined))
    await waitFor(() => expect(apiMock.diffPatch).toHaveBeenCalledTimes(2))
  })

  it("reloads on an unknown rev despite a sidebar edit hidden by the closed sidebar", async () => {
    let expired = false
    let refused = 0
    apiMock.reviewComments.mockImplementation(async (_p: string, v?: { newRev: string }) => {
      if (v && expired) {
        refused++
        throw new HttpError("unknown rev", 404)
      }
      return { comments: [comment(1, "shown")] }
    })
    window.sessionStorage.setItem("worktree.reviewSidebar", "true")
    setup()
    await screen.findByRole("button", { name: "Copy comments for agent" })
    await waitFor(() => expect(apiMock.reviewComments).toHaveBeenCalledWith("/wt/foo", { oldRev: "mb", newRev: "snap" }))
    const edit = renderHook(() => useEditorDraft("/wt/foo", editDraftKey("sidebar", 1))).result
    act(() => edit.current[1]({ text: "typing", baseVersion: 1 }))
    expired = true
    await refetchComments()
    await waitFor(() => expect(refused).toBe(1))
    await act(async () => {})
    // Open, the sidebar's editor holds the reload back.
    expect(apiMock.diffPatch).toHaveBeenCalledTimes(1)
    act(() => setReviewSidebar(false))
    await waitFor(() => expect(apiMock.diffPatch).toHaveBeenCalledTimes(2))
    // The hidden draft outlives the reload.
    expect(edit.current[0]?.text).toBe("typing")
    act(() => edit.current[1](undefined))
  })

  it("does not reload on an unknown rev while a new comment is open", async () => {
    let expired = false
    let refused = 0
    apiMock.reviewComments.mockImplementation(async (_p: string, v?: { newRev: string }) => {
      if (v && expired) {
        refused++
        throw new HttpError("unknown rev", 404)
      }
      return { comments: [] }
    })
    setup()
    await screen.findByTestId("diff-body")
    await waitFor(() => expect(apiMock.reviewComments).toHaveBeenCalledWith("/wt/foo", { oldRev: "mb", newRev: "snap" }))
    await userEvent.click(screen.getByRole("button", { name: "start comment" }))
    expired = true
    await refetchComments()
    await waitFor(() => expect(refused).toBe(1))
    await act(async () => {})
    expect(apiMock.diffPatch).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole("button", { name: "end comment" }))
    await waitFor(() => expect(apiMock.diffPatch).toHaveBeenCalledTimes(2))
  })

  it("gives the body no comments until the new view's own list arrives", async () => {
    let answer: (v: { comments: ReviewCommentItem[] }) => void = () => {}
    apiMock.reviewComments.mockImplementation((_p: string, v?: { newRev: string }) =>
      v?.newRev === "snap2"
        ? new Promise((resolve) => { answer = resolve })
        : Promise.resolve({ comments: [comment(1, "shown")] }),
    )
    apiMock.patches = [patch(), patch({ new_rev: "snap2" })]
    window.sessionStorage.setItem("worktree.reviewSidebar", "true")
    setup()
    await waitFor(() => expect(screen.getByTestId("diff-body")).toHaveAttribute("data-comments", "1"))
    await userEvent.click(screen.getByRole("switch", { name: "Hide whitespace" }))
    await waitFor(() => expect(apiMock.reviewComments).toHaveBeenCalledWith("/wt/foo", { oldRev: "mb", newRev: "snap2" }))
    expect(screen.getByTestId("diff-body")).toHaveAttribute("data-comments", "")
    // The sidebar keeps the list meanwhile.
    expect(screen.getByRole("button", { name: "Local review comments (1)" })).toBeInTheDocument()
    await act(async () => answer({ comments: [comment(2, "shown")] }))
    await waitFor(() => expect(screen.getByTestId("diff-body")).toHaveAttribute("data-comments", "2"))
  })

  it("reloads at most once for the same revs", async () => {
    apiMock.reviewComments.mockImplementation(async (_p: string, v?: { newRev: string }) => {
      if (v) throw new HttpError("unknown rev", 404)
      return { comments: [] }
    })
    setup()
    await screen.findByTestId("diff-body")
    await waitFor(() => expect(apiMock.diffPatch).toHaveBeenCalledTimes(2))
    await refetchComments()
    await refetchComments()
    expect(apiMock.diffPatch).toHaveBeenCalledTimes(2)
  })
})
