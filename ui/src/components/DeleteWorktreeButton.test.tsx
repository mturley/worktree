import { afterEach, describe, it, expect, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "wouter"
import { memoryLocation } from "wouter/memory-location"
import { DeleteWorktreeButton } from "./DeleteWorktreeButton"
import { JobModalHost } from "./jobs/JobModalHost"
import { applyJob, setJobs } from "../lib/jobsStore"
import type { Job, WorktreeSummary } from "../api/types"

const deleteWorktree = vi.fn()
const jobDismiss = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      worktreeInfo: async () => ({
        env: [],
        git: { branch: "my-branch", upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0 },
      }),
      deleteWorktree: (...a: unknown[]) => deleteWorktree(...a),
      jobDismiss: (...a: unknown[]) => jobDismiss(...a),
    },
  }
})

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const w = { path: "/wt/foo", repo: "odh", branch: "my-branch", on_disk: true } as WorktreeSummary

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  kind: "worktree_delete",
  title: "Delete worktree foo",
  target: "/wt/foo",
  state: "running",
  steps: [{ key: "remove_directory", label: "Remove worktree directory", status: "running" }],
  question: null,
  result: null,
  created_at: "2026-11-16T10:00:00Z",
  updated_at: "2026-11-16T10:00:00Z",
  ...over,
})

const succeeded = (): Job => job({
  state: "succeeded",
  steps: [{ key: "remove_directory", label: "Remove worktree directory", status: "done" }],
})

const wrap = () =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DeleteWorktreeButton w={w} />
      </QueryClientProvider>
    </MantineProvider>,
  )

afterEach(() => {
  cleanup()
  act(() => setJobs([]))
  deleteWorktree.mockReset()
  jobDismiss.mockReset()
})

describe("DeleteWorktreeButton", () => {
  it("opens the delete modal from the trash control", async () => {
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("button", { name: /delete worktree/i }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    // The typed-name confirmation is the safeguard; it must be present.
    expect(screen.getByLabelText(/type the worktree name/i)).toBeInTheDocument()
  })

  it("does not delete anything just by opening the modal", async () => {
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("button", { name: /delete worktree/i }))
    expect(await screen.findByRole("button", { name: /^delete$/i })).toBeDisabled()
  })

  // The button sits on the worktree's own card, on the worktree's own page.
  // Both of those go the moment the worktree leaves the list — which is the
  // moment the delete has its report to give. The started job therefore goes
  // to the root-mounted host, which outlives all of it.
  it("hands the started job to the modal host, which survives the page going", async () => {
    const user = userEvent.setup()
    deleteWorktree.mockResolvedValue({ job: job(), attached: false })
    jobDismiss.mockResolvedValue(undefined)
    const loc = memoryLocation({ path: `/worktree/${encodeURIComponent("/wt/foo")}`, record: true })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    // `present` stands in for the worktree being in the ["worktrees"] list:
    // the card, the button and anything under them are mounted only while it
    // is there.
    const Page = ({ present }: { present: boolean }) => (
      <MantineProvider>
        <QueryClientProvider client={qc}>
          <Router hook={loc.hook}>
            {present && <DeleteWorktreeButton w={w} />}
            <JobModalHost />
          </Router>
        </QueryClientProvider>
      </MantineProvider>
    )
    const { rerender } = render(<Page present />)

    await user.click(screen.getByRole("button", { name: /delete worktree/i }))
    await user.type(await screen.findByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))
    await waitFor(() => expect(deleteWorktree).toHaveBeenCalledWith({
      path: "/wt/foo", delete_branch: false,
    }))

    // The job finishes and the worktree drops out of the list, taking the
    // card with it.
    act(() => applyJob(succeeded()))
    rerender(<Page present={false} />)

    expect(await screen.findByText("Remove worktree directory")).toBeInTheDocument()
    const ok = screen.getByRole("button", { name: /^ok$/i })
    await user.click(ok)
    expect(jobDismiss).toHaveBeenCalledWith("j1")
    expect(loc.history?.at(-1)).toBe("/")
  })
})
