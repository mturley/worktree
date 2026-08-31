import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { NewWorktreeModal } from "./NewWorktreeModal"
import { api } from "../api/client"

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <NewWorktreeModal opened onClose={() => {}} />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

describe("NewWorktreeModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, "repos").mockResolvedValue([
      { name: "worktree", repo_root: "/git/worktree" },
      { name: "other", repo_root: "/git/other" },
    ])
    vi.spyOn(api, "repoDotfiles").mockResolvedValue([".env.local"])
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
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

  it("re-posts with reuse_branch when the confirmation is accepted", async () => {
    const create = vi.spyOn(api, "createWorktree")
      .mockResolvedValueOnce({
        ok: true, steps: [],
        confirm: { key: "reuse_branch", branch: "review/pr-1" },
      })
      .mockResolvedValueOnce({ ok: true, steps: [], confirm: null, path: "/wt/x" })

    renderModal()
    await screen.findByDisplayValue("worktree")
    await userEvent.type(screen.getByLabelText(/branch, pr, or issue/i), "42")
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))

    await screen.findByText(/already exists/i)
    await userEvent.click(screen.getByRole("button", { name: /reuse/i }))

    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ reuse_branch: true }),
    )
  })
})
