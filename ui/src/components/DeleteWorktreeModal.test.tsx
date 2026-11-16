import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { DeleteWorktreeModal } from "./DeleteWorktreeModal"
import { applyJob, setJobs, useAttachedJobIds } from "../lib/jobsStore"
import type { Job, JobStep } from "../api/types"

const deleteWorktree = vi.fn()
const jobAnswer = vi.fn()
const jobRetry = vi.fn()
const jobDismiss = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      deleteWorktree: (...a: unknown[]) => deleteWorktree(...a),
      jobAnswer: (...a: unknown[]) => jobAnswer(...a),
      jobRetry: (...a: unknown[]) => jobRetry(...a),
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

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(() => {
  cleanup()
  act(() => setJobs([]))
  for (const m of [deleteWorktree, jobAnswer, jobRetry, jobDismiss]) m.mockReset()
})

const modal = (over: Partial<React.ComponentProps<typeof DeleteWorktreeModal>> = {}) => (
  <DeleteWorktreeModal
    opened
    path="/wt/foo"
    name="foo"
    branch="feature"
    onClose={vi.fn()}
    onDeleted={vi.fn()}
    {...over}
  />
)

const steps: JobStep[] = [
  { key: "remove_directory", label: "Remove worktree directory", status: "running" },
  { key: "release_ports", label: "Release port range", status: "pending" },
]

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  kind: "worktree_delete",
  title: "Deleting foo",
  target: "/wt/foo",
  state: "running",
  steps,
  question: null,
  result: null,
  created_at: "2026-11-16T10:00:00Z",
  updated_at: "2026-11-16T10:00:00Z",
  ...over,
})

const parked = (key: string): Job => job({
  state: "needs_answer",
  question: { key },
  steps: [{ key, label: "Remove worktree directory", status: "needs_force", detail: "fatal: could not remove" }],
})

const succeeded = (): Job => job({
  state: "succeeded",
  steps: steps.map((s) => ({ ...s, status: "done" })),
})

const startJob = async (user: ReturnType<typeof userEvent.setup>) => {
  deleteWorktree.mockResolvedValue({ job: job(), attached: false })
  await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
  await user.click(screen.getByRole("button", { name: /^delete$/i }))
  await waitFor(() => expect(deleteWorktree).toHaveBeenCalled())
}

describe("DeleteWorktreeModal", () => {
  it("keeps Delete disabled until the worktree name is typed exactly", async () => {
    const user = userEvent.setup()
    wrap(modal())
    const button = screen.getByRole("button", { name: /^delete$/i })
    expect(button).toBeDisabled()
    await user.type(screen.getByLabelText(/type the worktree name/i), "fo")
    expect(button).toBeDisabled()
    await user.type(screen.getByLabelText(/type the worktree name/i), "o")
    expect(button).toBeEnabled()
  })

  it("starts a job and shows its steps as they arrive", async () => {
    const user = userEvent.setup()
    wrap(modal())
    await startJob(user)
    expect(deleteWorktree).toHaveBeenCalledWith({ path: "/wt/foo", delete_branch: false })

    act(() => applyJob(job()))
    expect(await screen.findByLabelText("In progress")).toBeInTheDocument()
    expect(screen.getByText("Deleting foo")).toBeInTheDocument()

    act(() => applyJob(job({
      steps: [
        { key: "remove_directory", label: "Remove worktree directory", status: "done" },
        { key: "release_ports", label: "Release port range", status: "running" },
      ],
    })))
    expect(screen.getAllByLabelText("In progress")).toHaveLength(1)
    expect(screen.getByText("Release port range")).toBeInTheDocument()
  })

  it("shows a request error in the alert", async () => {
    const user = userEvent.setup()
    deleteWorktree.mockRejectedValue(new Error("boom"))
    wrap(modal())
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))
    expect(await screen.findByText("boom")).toBeInTheDocument()
  })

  it("closing while running leaves the job alone", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    wrap(modal({ onClose }))
    await startJob(user)
    act(() => applyJob(job()))
    expect(await screen.findByText(/keeps running if you close this window/i)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /^close$/i }))
    expect(jobDismiss).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("a force question answers yes", async () => {
    const user = userEvent.setup()
    jobAnswer.mockResolvedValue(job())
    act(() => applyJob(parked("remove_directory")))
    wrap(modal({ jobId: "j1" }))
    await user.click(await screen.findByRole("button", { name: "Force-remove the directory" }))
    expect(jobAnswer).toHaveBeenCalledWith("j1", "yes")
  })

  it("offers to force-delete the branch for that question", async () => {
    const user = userEvent.setup()
    jobAnswer.mockResolvedValue(job())
    act(() => applyJob(parked("delete_branch")))
    wrap(modal({ jobId: "j1" }))
    await user.click(await screen.findByRole("button", { name: "Force-delete the branch" }))
    expect(jobAnswer).toHaveBeenCalledWith("j1", "yes")
  })

  it("declining the branch force answers no and stays open", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    jobAnswer.mockResolvedValue(job())
    act(() => applyJob(parked("delete_branch")))
    wrap(modal({ jobId: "j1", onClose }))
    await user.click(await screen.findByRole("button", { name: /^cancel$/i }))
    await waitFor(() => expect(jobAnswer).toHaveBeenCalledWith("j1", "no"))
    expect(onClose).not.toHaveBeenCalled()
  })

  it("declining the directory force answers no and closes", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    jobAnswer.mockResolvedValue(job())
    act(() => applyJob(parked("remove_directory")))
    wrap(modal({ jobId: "j1", onClose }))
    await user.click(await screen.findByRole("button", { name: /^cancel$/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(jobAnswer).toHaveBeenCalledWith("j1", "no")
  })

  it("OK on success dismisses and reports deleted", async () => {
    const user = userEvent.setup()
    const onDeleted = vi.fn()
    jobDismiss.mockResolvedValue(undefined)
    wrap(modal({ onDeleted }))
    await startJob(user)
    act(() => applyJob(succeeded()))
    await user.click(await screen.findByRole("button", { name: /^ok$/i }))
    expect(jobDismiss).toHaveBeenCalledWith("j1")
    expect(onDeleted).toHaveBeenCalled()
  })

  it("still reports deleted when the job is already gone on dismiss", async () => {
    const user = userEvent.setup()
    const onDeleted = vi.fn()
    jobDismiss.mockRejectedValue(new Error("404"))
    wrap(modal({ onDeleted }))
    await startJob(user)
    act(() => applyJob(succeeded()))
    await user.click(await screen.findByRole("button", { name: /^ok$/i }))
    expect(onDeleted).toHaveBeenCalled()
  })

  it("keeps showing a job that left the store", async () => {
    const user = userEvent.setup()
    wrap(modal())
    await startJob(user)
    act(() => applyJob(succeeded()))
    await screen.findByRole("button", { name: /^ok$/i })
    act(() => applyJob({ ...succeeded(), dismissed: true }))
    expect(screen.getByText("Remove worktree directory")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^ok$/i })).toBeInTheDocument()
  })

  // Over plain HTTP a hidden tab gives up its stream, so a job can finish and
  // expire with this tab hearing none of it. What is left must not be a
  // spinner that never resolves.
  it("says so when the job ended while the tab was away", async () => {
    const user = userEvent.setup()
    wrap(modal())
    await startJob(user)
    act(() => applyJob(job()))
    expect(await screen.findByLabelText("In progress")).toBeInTheDocument()

    act(() => setJobs([]))
    expect(await screen.findByText("This finished while this tab was away.")).toBeInTheDocument()
    expect(screen.queryByLabelText("In progress")).not.toBeInTheDocument()
    expect(screen.queryByText(/keeps running if you close this window/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^close$/i })).toBeInTheDocument()
  })

  it("says so when it is opened on a job it has never seen", () => {
    wrap(modal({ jobId: "nosuchjob", path: undefined, name: undefined, branch: undefined }))
    expect(screen.getByText("This job is no longer running.")).toBeInTheDocument()
    expect(screen.queryByLabelText(/type the worktree name/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^delete$/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^close$/i })).toBeInTheDocument()
  })

  // A destructive dialog must never open on a previous run's results.
  it("reopening after a finished job shows a fresh confirmation form", async () => {
    const user = userEvent.setup()
    const { rerender } = wrap(modal())
    await startJob(user)
    act(() => applyJob(succeeded()))
    await screen.findByRole("button", { name: /^ok$/i })

    rerender(<MantineProvider>{modal({ opened: false })}</MantineProvider>)
    rerender(<MantineProvider>{modal()}</MantineProvider>)
    expect(await screen.findByLabelText(/type the worktree name/i)).toHaveValue("")
    expect(screen.queryByText("Remove worktree directory")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeDisabled()
  })

  it("retargeting at another worktree shows a fresh confirmation form", async () => {
    const user = userEvent.setup()
    const { rerender } = wrap(modal())
    await startJob(user)
    act(() => applyJob(succeeded()))
    await screen.findByRole("button", { name: /^ok$/i })

    rerender(<MantineProvider>{modal({ path: "/wt/bar", name: "bar" })}</MantineProvider>)
    expect(await screen.findByLabelText(/type the worktree name/i)).toHaveValue("")
    expect(screen.queryByText("Remove worktree directory")).not.toBeInTheDocument()
  })

  it("a failed job offers Run again", async () => {
    const user = userEvent.setup()
    jobRetry.mockResolvedValue(job())
    act(() => applyJob(job({
      state: "failed",
      error: "delete run aborted",
      steps: [{ key: "remove_directory", label: "Remove worktree directory", status: "failed", detail: "fatal: x" }],
    })))
    wrap(modal({ jobId: "j1" }))
    expect(await screen.findByText("delete run aborted")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /run again/i }))
    expect(jobRetry).toHaveBeenCalledWith("j1")
  })

  it("opens straight on an existing job", async () => {
    act(() => applyJob(parked("remove_directory")))
    wrap(modal({ jobId: "j1", path: undefined, name: undefined, branch: undefined }))
    expect(await screen.findByRole("button", { name: "Force-remove the directory" })).toBeInTheDocument()
    expect(screen.queryByLabelText(/type the worktree name/i)).not.toBeInTheDocument()
  })

  it("hides its job's toast while open", async () => {
    let seen: ReadonlySet<string> = new Set()
    const Probe = () => {
      seen = useAttachedJobIds()
      return null
    }
    act(() => applyJob(job()))
    const { rerender } = wrap(<>{modal({ jobId: "j1" })}<Probe /></>)
    await waitFor(() => expect(seen.has("j1")).toBe(true))

    rerender(<MantineProvider>{modal({ jobId: "j1", opened: false })}<Probe /></MantineProvider>)
    await waitFor(() => expect(seen.has("j1")).toBe(false))
  })
})
