import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DiffCommits, DiffPatch, WorktreeGit } from "../../api/types"
import { setViewport } from "../../testing/viewport"

// pierre renders into shadow DOM, which tests can't see into: stand the body
// in with what it was given.
vi.mock("./DiffBody", () => ({
  DiffBody: (p: { files: { path: string }[]; mode: string; highlighted: string | null }) => (
    <div data-testid="diff-body" data-mode={p.mode} data-highlighted={p.highlighted ?? ""}>
      {p.files.map((f) => f.path).join(",")}
    </div>
  ),
}))

// Scrolling is scrollToFile's (tested on its own); here, only that it is asked.
const scrollMock = vi.hoisted(() => ({ scrollToFile: vi.fn(() => () => {}) }))
vi.mock("./scrollToFile", () => ({ DIFF_SCROLLER_CLASS: "diff-body-scroller", scrollToFile: scrollMock.scrollToFile }))

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
}))
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return {
    api: {
      ...actual.api,
      settings: async () => ({ worktree: { editor: "code" } }),
      diffCommits: apiMock.diffCommits,
      diffPatch: apiMock.diffPatch,
    },
  }
})

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

const patch = (over: Partial<DiffPatch> = {}): DiffPatch => ({
  list_id: "L1",
  working_fingerprint: "W1",
  old_rev: "mb",
  new_rev: "snap",
  patch: PATCH("a.go"),
  ...over,
})

const tree = () => (
  <MantineProvider>
    <QueryClientProvider client={client}>
      <DiffView path="/wt/foo" headerHeight={100} />
    </QueryClientProvider>
  </MantineProvider>
)
let client: QueryClient

const setup = () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(tree())
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
    await userEvent.click(screen.getByRole("button", { name: "← Code" }))
    expect(new URLSearchParams(window.location.search).has("diff")).toBe(false)
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
})
