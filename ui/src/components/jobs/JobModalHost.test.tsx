import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "wouter"
import { memoryLocation } from "wouter/memory-location"
import { JobModalHost } from "./JobModalHost"
import { applyJob, closeJobModal, openJobModal, setJobs } from "../../lib/jobsStore"
import type { Job } from "../../api/types"

const jobDismiss = vi.fn()
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return { api: { ...actual.api, jobDismiss: (...a: unknown[]) => jobDismiss(...a) } }
})

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  kind: "worktree_delete",
  title: "Deleting foo",
  target: "/wt/foo",
  state: "running",
  steps: [{ key: "remove_directory", label: "Remove worktree directory", status: "running" }],
  question: null,
  result: null,
  created_at: "2026-11-16T10:00:00Z",
  updated_at: "2026-11-16T10:00:00Z",
  ...over,
})

const wrap = (path = "/") => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const loc = memoryLocation({ path, record: true })
  const view = render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <Router hook={loc.hook}>
          <JobModalHost />
        </Router>
      </QueryClientProvider>
    </MantineProvider>,
  )
  return { ...view, loc, qc }
}

afterEach(() => {
  cleanup()
  act(() => {
    setJobs([])
    closeJobModal()
  })
  jobDismiss.mockReset()
})

const createJob = (over: Partial<Job> = {}): Job => job({
  id: "j2",
  kind: "worktree_create",
  title: "Creating foo",
  steps: [{ key: "create", label: "Create the worktree", status: "running" }],
  ...over,
})

describe("JobModalHost", () => {
  it("opens the delete modal on a delete job", async () => {
    act(() => setJobs([job()]))
    wrap()
    act(() => openJobModal(job()))
    expect(await screen.findByText("Remove worktree directory")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("opens the new-worktree modal on a create job", async () => {
    act(() => setJobs([createJob()]))
    wrap()
    act(() => openJobModal(createJob()))
    expect(await screen.findByText("Create the worktree")).toBeInTheDocument()
  })

  it("renders nothing for a kind it has no modal for", () => {
    act(() => setJobs([job({ kind: "something_else" })]))
    wrap()
    act(() => openJobModal(job({ kind: "something_else" })))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  // The server expires a clean success ten seconds after it finishes, and
  // another tab can dismiss one sooner. Neither may pull the modal out from
  // under somebody reading the step report.
  it("keeps the modal when the job leaves the store", async () => {
    act(() => setJobs([job()]))
    wrap()
    act(() => openJobModal(job()))
    await screen.findByText("Remove worktree directory")
    act(() => applyJob(job({ dismissed: true })))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("Remove worktree directory")).toBeInTheDocument()
  })

  // The start response and the job's stream event race, so a modal opened
  // straight from the start response must show the job the caller has in hand
  // rather than claiming it is no longer running.
  it("shows a job the store has not heard of yet", async () => {
    wrap()
    act(() => openJobModal(job()))
    expect(await screen.findByText("Remove worktree directory")).toBeInTheDocument()
    expect(screen.queryByText("This job is no longer running.")).not.toBeInTheDocument()
  })

  it("goes home when the deleted worktree's own page is open", async () => {
    const user = userEvent.setup()
    jobDismiss.mockResolvedValue(undefined)
    act(() => setJobs([job({ state: "succeeded", steps: [
      { key: "remove_directory", label: "Remove worktree directory", status: "done" },
    ] })]))
    const { loc } = wrap(`/worktree/${encodeURIComponent("/wt/foo")}`)
    act(() => openJobModal(job()))
    await user.click(await screen.findByRole("button", { name: /^ok$/i }))
    expect(loc.history?.at(-1)).toBe("/")
  })

  it("stays put when another page is open", async () => {
    const user = userEvent.setup()
    jobDismiss.mockResolvedValue(undefined)
    act(() => setJobs([job({ state: "succeeded", steps: [
      { key: "remove_directory", label: "Remove worktree directory", status: "done" },
    ] })]))
    const { loc } = wrap(`/worktree/${encodeURIComponent("/wt/other")}`)
    act(() => openJobModal(job()))
    await user.click(await screen.findByRole("button", { name: /^ok$/i }))
    expect(loc.history?.at(-1)).toBe(`/worktree/${encodeURIComponent("/wt/other")}`)
  })
})
