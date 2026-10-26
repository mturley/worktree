import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DiffCommits, DiffFiles, WorktreeGit } from "../../api/types"
import { GitDiffPanel } from "./GitDiffPanel"

const api = vi.hoisted(() => ({
  worktreeGit: vi.fn(),
  diffCommits: vi.fn(),
  diffFiles: vi.fn(),
  reviewComments: vi.fn(),
}))

vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return {
    api: {
      ...actual.api,
      worktreeGit: api.worktreeGit,
      diffCommits: api.diffCommits,
      diffFiles: api.diffFiles,
      reviewComments: api.reviewComments,
      settings: async () => ({ worktree: { editor: "code" } }),
    },
  }
})

const git: WorktreeGit = {
  on_disk: true, fingerprint: "f", working_fingerprint: "wf", branch: "b",
  main_upstream: "upstream/main", merge_base: "76ef50c1234567890abcdef1234567890abcdef12",
  vs_merge_base: { ahead: 1, behind: 0 },
  tracking: "origin/b", vs_tracking: { ahead: 0, behind: 0 },
  working: { staged: 0, modified: 0, untracked: 0, files: 0 },
  fetch: { last_ok_at: new Date().toISOString(), in_progress: false },
}
const commits: DiffCommits = { list_id: "L", base_ref: "upstream/main", merge_base: "m", commits: [] }
const files: DiffFiles = {
  fingerprint: "f",
  list_id: "L",
  files: [
    { path: "a.go", status: "M", additions: 3, deletions: 1, binary: false },
    { path: "b.go", status: "A", additions: 5, deletions: 0, binary: false },
  ],
}

const OPEN_KEY = "worktree.filesChangedOpen"

beforeEach(() => {
  window.localStorage.clear()
  api.worktreeGit.mockResolvedValue(git)
  api.diffCommits.mockResolvedValue(commits)
  api.diffFiles.mockResolvedValue(files)
  api.reviewComments.mockResolvedValue({ comments: [] })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const wrap = () =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <GitDiffPanel path="/w/a" repo="r" />
      </QueryClientProvider>
    </MantineProvider>,
  )

describe("Review changes button", () => {
  it("counts the worktree's pending local comments, in the unread blue", async () => {
    api.reviewComments.mockResolvedValue({ comments: [{ id: 1 }, { id: 2 }, { id: 3 }] })
    wrap()
    const button = await screen.findByRole("button", { name: "Review changes (3 pending local comments)" })
    expect(button).toHaveAttribute("data-variant", "filled")
    // No view: the whole worktree's list.
    expect(api.reviewComments).toHaveBeenCalledWith("/w/a", undefined)
  })

  it("says comment for one", async () => {
    api.reviewComments.mockResolvedValue({ comments: [{ id: 1 }] })
    wrap()
    expect(await screen.findByRole("button", { name: "Review changes (1 pending local comment)" })).toBeInTheDocument()
  })

  it("is plain with none", async () => {
    wrap()
    const button = await screen.findByRole("button", { name: "Review changes" })
    expect(button).toHaveAttribute("data-variant", "light")
  })
})

describe("Files changed section", () => {
  it("starts collapsed, with the header's count and totals still shown", async () => {
    wrap()
    expect(await screen.findByText("Files changed (2)")).toBeInTheDocument()
    expect(screen.getByText("+8")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show files" })).toBeInTheDocument()
    expect(screen.queryByTestId("file-row")).toBeNull()
    // At the top, above the git summary: Review changes, then Open in editor.
    const review = screen.getByRole("button", { name: "Review changes" })
    const editor = screen.getByRole("button", { name: /Open in editor/ })
    expect(review.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(editor.compareDocumentPosition(screen.getByText(/^upstream\/main @/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(editor.compareDocumentPosition(screen.getByText("Files changed (2)")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("expands and collapses from the chevron, remembering the choice", async () => {
    const user = userEvent.setup()
    wrap()
    await screen.findByText("Files changed (2)")
    await user.click(screen.getByRole("button", { name: "Show files" }))
    expect(screen.getAllByTestId("file-row")).toHaveLength(2)
    expect(window.localStorage.getItem(OPEN_KEY)).toBe("true")
    await user.click(screen.getByRole("button", { name: "Hide files" }))
    expect(screen.queryByTestId("file-row")).toBeNull()
    expect(window.localStorage.getItem(OPEN_KEY)).toBe("false")
  })

  it("toggles from the title too", async () => {
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByText("Files changed (2)"))
    expect(screen.getAllByTestId("file-row")).toHaveLength(2)
    await user.click(screen.getByText("Files changed (2)"))
    expect(screen.queryByTestId("file-row")).toBeNull()
  })

  it("opens expanded when that was the last choice", async () => {
    window.localStorage.setItem(OPEN_KEY, "true")
    wrap()
    expect(await screen.findAllByTestId("file-row")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Hide files" })).toBeInTheDocument()
  })

  it("still works when storage is blocked", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "Show files" }))
    expect(screen.getAllByTestId("file-row")).toHaveLength(2)
    get.mockRestore()
    set.mockRestore()
  })
})
