import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, act } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "wouter"
import { memoryLocation } from "wouter/memory-location"
import { JobModalHost } from "./JobModalHost"
import { closeJobModal, openJobModal, setJobs } from "../../lib/jobsStore"
import type { Job } from "../../api/types"

vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return { api: { ...actual.api } }
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

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <Router hook={memoryLocation({ path: "/" }).hook}>
          <JobModalHost />
        </Router>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

afterEach(() => {
  cleanup()
  act(() => {
    setJobs([])
    closeJobModal()
  })
})

describe("JobModalHost", () => {
  it("opens the delete modal on a delete job", async () => {
    act(() => setJobs([job()]))
    wrap()
    act(() => openJobModal("j1"))
    expect(await screen.findByText("Remove worktree directory")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("opens the new-worktree modal on a create job", async () => {
    act(() => setJobs([job({
      id: "j2",
      kind: "worktree_create",
      title: "Creating foo",
      steps: [{ key: "create", label: "Create the worktree", status: "running" }],
    })]))
    wrap()
    act(() => openJobModal("j2"))
    expect(await screen.findByText("Create the worktree")).toBeInTheDocument()
  })

  it("renders nothing for an unknown id", () => {
    wrap()
    act(() => openJobModal("gone"))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
