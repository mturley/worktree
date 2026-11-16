import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { NewWorktreeModal } from "./NewWorktreeModal"
import { api } from "../api/client"
import { applyJob, setJobs } from "../lib/jobsStore"
import type { Job, JobStep } from "../api/types"

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const steps: JobStep[] = [
  { key: "create_worktree", label: "Create the worktree", status: "running" },
  { key: "register", label: "Register it", status: "pending" },
]

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  kind: "worktree_create",
  title: "Creating my-feature",
  target: "my-feature",
  state: "running",
  steps,
  question: null,
  result: null,
  created_at: "2026-11-16T10:00:00Z",
  updated_at: "2026-11-16T10:00:00Z",
  ...over,
})

const succeeded = (path: string): Job => job({
  state: "succeeded",
  result: { path },
  steps: steps.map((s) => ({ ...s, status: "done" })),
})

function renderModal(props: Partial<React.ComponentProps<typeof NewWorktreeModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  const view = render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <NewWorktreeModal opened onClose={onClose} {...props} />
      </QueryClientProvider>
    </MantineProvider>,
  )
  return { ...view, onClose }
}

let jobAnswer: MockInstance<typeof api.jobAnswer>
let jobDismiss: MockInstance<typeof api.jobDismiss>

beforeEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, "", "/")
  vi.spyOn(api, "repos").mockResolvedValue([
    { name: "worktree", repo_root: "/git/worktree" },
    { name: "other", repo_root: "/git/other" },
  ])
  vi.spyOn(api, "repoDotfiles").mockResolvedValue([".env.local"])
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
  vi.spyOn(api, "defaultBranch").mockImplementation(async (input) => ({
    branch: /^[A-Z]+-\d+$/.test(input) ? input.toLowerCase() : "",
  }))
  jobAnswer = vi.spyOn(api, "jobAnswer").mockResolvedValue(job())
  jobDismiss = vi.spyOn(api, "jobDismiss").mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  act(() => setJobs([]))
})

const type = async (value: string) => {
  await screen.findByDisplayValue("worktree")
  await userEvent.type(screen.getByLabelText(/branch, pr, or issue/i), value)
}

const withCmux = () => {
  vi.spyOn(api, "cmux").mockResolvedValue({ available: true })
  vi.spyOn(api, "cmuxGroups").mockResolvedValue({
    groups: [{ ref: "group:1", name: "Work" }],
    colors: [{ name: "Blue", hex: "#0000ff" }],
  })
}

describe("NewWorktreeModal", () => {
  it("offers the issue's default branch for editing and posts the edit", async () => {
    const create = vi.spyOn(api, "createWorktree").mockResolvedValue({ job: job(), attached: false })
    renderModal()
    await type("PROJ-7")
    const branch = await screen.findByDisplayValue("proj-7")
    await userEvent.type(branch, "-tidy")
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: "PROJ-7", branch: "proj-7-tidy" }),
    )
    await screen.findByText("Creating my-feature")
  })

  it("asks no branch name for a plain branch input", async () => {
    const create = vi.spyOn(api, "createWorktree").mockResolvedValue({ job: job(), attached: false })
    renderModal()
    await type("my-feature")
    await waitFor(() =>
      expect(api.defaultBranch).toHaveBeenCalledWith("my-feature", "/git/worktree"))
    expect(screen.queryByLabelText(/^branch name/i)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))
    expect(create.mock.lastCall?.[0]).toEqual(expect.not.objectContaining({ branch: expect.anything() }))
    await screen.findByText("Creating my-feature")
  })

  it("defaults to the first (most recent) repo", async () => {
    renderModal()
    expect(await screen.findByDisplayValue("worktree")).toBeInTheDocument()
  })

  it("checks pull by default and leaves dotfiles unchecked", async () => {
    renderModal()
    expect(await screen.findByRole("checkbox", { name: /git pull/i })).toBeChecked()
    expect(await screen.findByRole("checkbox", { name: /dotfiles/i })).not.toBeChecked()
  })

  it("hides the cmux fields when cmux is unavailable", async () => {
    renderModal()
    await screen.findByDisplayValue("worktree")
    expect(screen.queryByLabelText(/workspace name/i)).toBeNull()
  })

  it("starts a job with the form's values", async () => {
    const create = vi.spyOn(api, "createWorktree").mockResolvedValue({ job: job(), attached: false })
    withCmux()
    renderModal()
    await type("my-feature")
    await userEvent.type(await screen.findByLabelText(/workspace name/i), "ws")
    await userEvent.click(await screen.findByRole("textbox", { name: "Group" }))
    await userEvent.click(await screen.findByRole("option", { name: "Work" }))
    await userEvent.click(await screen.findByRole("button", { name: "Blue" }))
    await userEvent.click(screen.getByRole("checkbox", { name: /dotfiles/i }))
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))

    expect(create).toHaveBeenCalledWith({
      input: "my-feature",
      repo_root: "/git/worktree",
      pull: true,
      copy_dotfiles: true,
      branch: undefined,
      workspace_name: "ws",
      workspace_group_ref: "group:1",
      workspace_color: "Blue",
    })
    await screen.findByText("Creating my-feature")
  })

  it("sends no workspace fields when the name is blank", async () => {
    const create = vi.spyOn(api, "createWorktree").mockResolvedValue({ job: job(), attached: false })
    withCmux()
    renderModal()
    await type("my-feature")
    await userEvent.click(await screen.findByRole("button", { name: "Blue" }))
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))

    const sent = create.mock.lastCall?.[0]
    expect(sent).toBeDefined()
    expect(sent?.workspace_name).toBeUndefined()
    expect(sent?.workspace_group_ref).toBeUndefined()
    expect(sent?.workspace_color).toBeUndefined()
    await screen.findByText("Creating my-feature")
  })

  it("shows live steps", async () => {
    vi.spyOn(api, "createWorktree").mockResolvedValue({ job: job(), attached: false })
    renderModal()
    await type("my-feature")
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))
    act(() => applyJob(job()))
    expect(await screen.findByLabelText("In progress")).toBeInTheDocument()
    expect(screen.getByText("Creating my-feature")).toBeInTheDocument()
    expect(screen.queryByLabelText(/branch, pr, or issue/i)).toBeNull()
  })

  it("reuse branch: yes answers yes", async () => {
    act(() => applyJob(job({
      state: "needs_answer",
      question: { key: "reuse_branch", branch: "review/pr-1" },
    })))
    renderModal({ jobId: "j1" })
    expect(await screen.findByText(/already checked out elsewhere/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /reuse branch/i }))
    expect(jobAnswer).toHaveBeenCalledWith("j1", "yes")
  })

  it("reuse branch: cancel answers no and closes", async () => {
    act(() => applyJob(job({
      state: "needs_answer",
      question: { key: "reuse_branch", branch: "review/pr-1" },
    })))
    const { onClose } = renderModal({ jobId: "j1" })
    await userEvent.click(await screen.findByRole("button", { name: /^cancel$/i }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(jobAnswer).toHaveBeenCalledWith("j1", "no")
  })

  it("reset to PR: Keep current commit answers no and stays open", async () => {
    act(() => applyJob(job({
      state: "needs_answer",
      question: { key: "reset_to_pr", branch: "b", local_head: "aaaaaaaa11", remote_head: "bbbbbbbb22" },
    })))
    const { onClose } = renderModal({ jobId: "j1" })
    expect(await screen.findByText(/aaaaaaaa.*bbbbbbbb/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /keep current commit/i }))
    await waitFor(() => expect(jobAnswer).toHaveBeenCalledWith("j1", "no"))
    expect(onClose).not.toHaveBeenCalled()
  })

  it("reset to PR: Reset to PR answers yes", async () => {
    act(() => applyJob(job({
      state: "needs_answer",
      question: { key: "reset_to_pr", branch: "b", local_head: "aaaaaaaa11", remote_head: "bbbbbbbb22" },
    })))
    renderModal({ jobId: "j1" })
    await userEvent.click(await screen.findByRole("button", { name: /reset to pr/i }))
    expect(jobAnswer).toHaveBeenCalledWith("j1", "yes")
  })

  it("a failed job shows its error and offers Run again", async () => {
    const retry = vi.spyOn(api, "jobRetry").mockResolvedValue(job())
    act(() => applyJob(job({ state: "failed", error: "git exploded" })))
    renderModal({ jobId: "j1" })
    expect(await screen.findByText("git exploded")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /run again/i }))
    expect(retry).toHaveBeenCalledWith("j1")
  })

  // The error is usually the failing step's own output: said twice it reads
  // like two things went wrong.
  it("does not repeat an error a step already shows", async () => {
    vi.spyOn(api, "jobRetry").mockResolvedValue(job())
    act(() => applyJob(job({
      state: "failed",
      error: "git exploded",
      steps: [{ key: "create_worktree", label: "Create the worktree", status: "failed", detail: "git exploded" }],
    })))
    renderModal({ jobId: "j1" })
    expect(await screen.findAllByText("git exploded")).toHaveLength(1)
  })

  it("says so when it is opened on a job it has never seen", async () => {
    renderModal({ jobId: "nosuchjob" })
    expect(await screen.findByText("This job is no longer running.")).toBeInTheDocument()
    expect(screen.queryByLabelText(/branch, pr, or issue/i)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^close$/i })).toBeInTheDocument()
  })

  it("says so when the job ended while the tab was away", async () => {
    vi.spyOn(api, "createWorktree").mockResolvedValue({ job: job(), attached: false })
    renderModal()
    await type("my-feature")
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))
    act(() => applyJob(job()))
    expect(await screen.findByLabelText("In progress")).toBeInTheDocument()

    act(() => setJobs([]))
    expect(await screen.findByText("This finished while this tab was away.")).toBeInTheDocument()
    expect(screen.queryByLabelText("In progress")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^close$/i })).toBeInTheDocument()
  })

  it("OK on success dismisses and navigates to the worktree", async () => {
    vi.spyOn(api, "createWorktree").mockResolvedValue({ job: job(), attached: false })
    const { onClose } = renderModal()
    await type("my-feature")
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))
    act(() => applyJob(succeeded("/wt/my feature")))
    await userEvent.click(await screen.findByRole("button", { name: /^ok$/i }))
    expect(jobDismiss).toHaveBeenCalledWith("j1")
    expect(onClose).toHaveBeenCalled()
    expect(window.location.pathname).toBe("/worktree/" + encodeURIComponent("/wt/my feature"))
  })

  it("closing while running dismisses nothing", async () => {
    act(() => applyJob(job()))
    const { onClose } = renderModal({ jobId: "j1" })
    expect(await screen.findByText(/keeps running if you close this window/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /^close$/i }))
    expect(jobDismiss).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("opens straight on an existing job", async () => {
    act(() => applyJob(job()))
    renderModal({ jobId: "j1" })
    expect(await screen.findByLabelText("In progress")).toBeInTheDocument()
    expect(screen.queryByLabelText(/branch, pr, or issue/i)).toBeNull()
  })
})
