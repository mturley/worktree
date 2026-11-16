import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { Router } from "wouter"
import { memoryLocation } from "wouter/memory-location"
import { JobToasts } from "./JobToasts"
import { applyJob, attachJob, closeJobModal, setJobs, useOpenJobModal } from "../../lib/jobsStore"
import type { Job, JobStep } from "../../api/types"

const jobRetry = vi.fn()
const jobDismiss = vi.fn()
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return {
    api: {
      ...actual.api,
      jobRetry: (...a: unknown[]) => jobRetry(...a),
      jobDismiss: (...a: unknown[]) => jobDismiss(...a),
    },
  }
})

const steps: JobStep[] = [
  { key: "a", label: "Fetch branch", status: "done" },
  { key: "b", label: "Create worktree", status: "running" },
]

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  kind: "worktree_create",
  title: "Creating foo",
  target: "foo",
  state: "running",
  steps,
  question: null,
  result: null,
  created_at: "2026-11-16T10:00:00Z",
  updated_at: "2026-11-16T10:00:00Z",
  ...over,
})

function OpenId() {
  return <span data-testid="open">{useOpenJobModal()?.id ?? "none"}</span>
}

function wrap(path = "/") {
  const loc = memoryLocation({ path, record: true })
  const view = render(
    <MantineProvider>
      <Router hook={loc.hook}>
        <JobToasts />
        <OpenId />
      </Router>
    </MantineProvider>,
  )
  return { ...view, loc }
}

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  act(() => {
    setJobs([])
    closeJobModal()
  })
  jobRetry.mockReset()
  jobDismiss.mockReset()
})

describe("JobToasts", () => {
  it("renders nothing with no jobs", () => {
    wrap()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("shows one toast per job, oldest first", () => {
    act(() => setJobs([
      job({ id: "j2", title: "Second", created_at: "2026-11-16T11:00:00Z" }),
      job({ id: "j1", title: "First" }),
    ]))
    wrap()
    const toasts = screen.getAllByRole("status")
    expect(toasts.map((t) => t.getAttribute("aria-label"))).toEqual(["First", "Second"])
  })

  it("a running job has no dismiss button; a failed one does", () => {
    act(() => setJobs([job()]))
    wrap()
    expect(screen.queryByLabelText("Dismiss")).not.toBeInTheDocument()
    act(() => applyJob(job({ state: "failed", error: "boom" })))
    expect(screen.getByLabelText("Dismiss")).toBeInTheDocument()
  })

  it("a needs_answer job has no dismiss button and opens its modal on click", async () => {
    const user = userEvent.setup()
    act(() => setJobs([job({ state: "needs_answer", question: { key: "reuse_branch" } })]))
    wrap()
    expect(screen.queryByLabelText("Dismiss")).not.toBeInTheDocument()
    expect(screen.getByText("Needs your answer: reuse existing branch?")).toBeInTheDocument()
    await user.click(screen.getByRole("status"))
    expect(screen.getByTestId("open")).toHaveTextContent("j1")
  })

  it("offers an Answer button in both views that opens the job's modal", async () => {
    const user = userEvent.setup()
    act(() => setJobs([job({ state: "needs_answer", question: { key: "reuse_branch" } })]))
    wrap()
    await user.click(screen.getByRole("button", { name: "Answer" }))
    expect(screen.getByTestId("open")).toHaveTextContent("j1")
    act(() => closeJobModal())
    await user.click(screen.getByLabelText("Collapse"))
    await user.click(screen.getByRole("button", { name: "Answer" }))
    expect(screen.getByTestId("open")).toHaveTextContent("j1")
  })

  it("collapsing or expanding a needs_answer toast does not open its modal", async () => {
    const user = userEvent.setup()
    act(() => setJobs([job({ state: "needs_answer", question: { key: "reuse_branch" } })]))
    wrap()
    await user.click(screen.getByLabelText("Collapse"))
    expect(screen.getByTestId("open")).toHaveTextContent("none")
    await user.click(screen.getByLabelText("Expand"))
    expect(screen.getByTestId("open")).toHaveTextContent("none")
  })

  it("collapsing shows only the current step's label and survives a remount", async () => {
    const user = userEvent.setup()
    act(() => setJobs([job()]))
    const first = wrap()
    expect(screen.getByText("Fetch branch")).toBeInTheDocument()
    await user.click(screen.getByLabelText("Collapse"))
    expect(screen.queryByText("Fetch branch")).not.toBeInTheDocument()
    expect(screen.getByText("Create worktree")).toBeInTheDocument()
    first.unmount()
    wrap()
    expect(screen.queryByText("Fetch branch")).not.toBeInTheDocument()
    expect(screen.getByText("Create worktree")).toBeInTheDocument()
    await user.click(screen.getByLabelText("Expand"))
    expect(screen.getByText("Fetch branch")).toBeInTheDocument()
  })

  it("hides a job attached to a modal in this tab", () => {
    act(() => setJobs([job()]))
    wrap()
    expect(screen.getByRole("status")).toBeInTheDocument()
    let detach = () => {}
    act(() => { detach = attachJob("j1") })
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    act(() => detach())
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("dismiss calls the API and does not remove the toast itself", async () => {
    const user = userEvent.setup()
    jobDismiss.mockResolvedValue(undefined)
    act(() => setJobs([job({ state: "failed", error: "boom" })]))
    wrap()
    await user.click(screen.getByLabelText("Dismiss"))
    expect(jobDismiss).toHaveBeenCalledWith("j1")
    expect(screen.getByRole("status")).toBeInTheDocument()
    act(() => applyJob(job({ state: "failed", error: "boom", dismissed: true })))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("shows the error when dismiss fails", async () => {
    const user = userEvent.setup()
    jobDismiss.mockRejectedValue(new Error("server said no"))
    act(() => setJobs([job({ state: "failed", error: "boom" })]))
    wrap()
    await user.click(screen.getByLabelText("Dismiss"))
    expect(await screen.findByText("server said no")).toBeInTheDocument()
  })

  it("an interrupted job offers Run again", async () => {
    const user = userEvent.setup()
    jobRetry.mockResolvedValue(job())
    act(() => setJobs([job({ state: "interrupted" })]))
    wrap()
    expect(screen.getByText("Interrupted: the server stopped")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Run again" }))
    expect(jobRetry).toHaveBeenCalledWith("j1")
  })

  it("shows the error when Run again fails", async () => {
    const user = userEvent.setup()
    jobRetry.mockRejectedValue(new Error("cannot retry"))
    act(() => setJobs([job({ state: "interrupted" })]))
    wrap()
    await user.click(screen.getByRole("button", { name: "Run again" }))
    expect(await screen.findByText("cannot retry")).toBeInTheDocument()
  })

  it("a succeeded create offers Open worktree", async () => {
    const user = userEvent.setup()
    jobDismiss.mockResolvedValue(undefined)
    act(() => setJobs([job({
      state: "succeeded",
      steps: steps.map((s) => ({ ...s, status: "done" as const })),
      result: { path: "/wt/foo bar", branch: "foo" },
    })]))
    const { loc } = wrap()
    await user.click(screen.getByRole("button", { name: "Open worktree" }))
    expect(loc.history?.at(-1)).toBe(`/worktree/${encodeURIComponent("/wt/foo bar")}`)
    await waitFor(() => expect(jobDismiss).toHaveBeenCalledWith("j1"))
  })

  // Collapsed, a finished job used to be a title and nothing else whenever
  // its detail sat on a step.
  it("a collapsed finished job says how it ended", async () => {
    const user = userEvent.setup()
    act(() => setJobs([job({
      state: "failed",
      error: "fatal: could not remove",
      steps: [{ key: "a", label: "Fetch branch", status: "failed", detail: "fatal: could not remove" }],
    })]))
    wrap()
    await user.click(screen.getByLabelText("Collapse"))
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })

  it("a collapsed success says Done", async () => {
    const user = userEvent.setup()
    act(() => setJobs([job({
      state: "succeeded",
      steps: steps.map((s) => ({ ...s, status: "done" as const })),
    })]))
    wrap()
    await user.click(screen.getByLabelText("Collapse"))
    expect(screen.getByText("Done")).toBeInTheDocument()
  })

  // The step's detail and the state line below it said the same thing.
  it("an interrupted job says the server stopped once", () => {
    act(() => setJobs([job({
      state: "interrupted",
      steps: [{ key: "a", label: "Fetch branch", status: "failed", detail: "interrupted: the server stopped" }],
    })]))
    wrap()
    expect(screen.getAllByText(/the server stopped/i)).toHaveLength(1)
    expect(screen.getByText("Interrupted: the server stopped")).toBeInTheDocument()
  })

  it("a succeeded job with a failed step shows that step's detail", () => {
    act(() => setJobs([job({
      state: "succeeded",
      steps: [{ key: "a", label: "Copy dotfiles", status: "failed", detail: "permission denied" }],
    })]))
    wrap()
    expect(screen.getByText("permission denied")).toBeInTheDocument()
  })
})
