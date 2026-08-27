import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { DeleteWorktreeModal } from "./DeleteWorktreeModal"
import type { DeleteWorktreeResponse } from "../api/types"

const deleteWorktree = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api, deleteWorktree: (...a: unknown[]) => deleteWorktree(...a) } }
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
afterEach(() => { cleanup(); deleteWorktree.mockReset() })

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

const ok = (over: Partial<DeleteWorktreeResponse> = {}): DeleteWorktreeResponse => ({
  ok: true,
  needs_force: "",
  steps: [
    { key: "remove_directory", label: "Remove worktree directory", status: "done" },
    { key: "release_ports", label: "Release port range", status: "done" },
  ],
  ...over,
})

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

  it("leaves the branch checkbox unchecked, and only sends delete_branch when ticked", async () => {
    const user = userEvent.setup()
    deleteWorktree.mockResolvedValue(ok())
    wrap(modal())

    const checkbox = screen.getByRole("checkbox", { name: /delete the branch/i })
    expect(checkbox).not.toBeChecked()

    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))
    await waitFor(() => expect(deleteWorktree).toHaveBeenCalled())
    expect(deleteWorktree.mock.calls[0][0]).toMatchObject({ path: "/wt/foo", delete_branch: false })
  })

  it("renders a stage per step once the run reports", async () => {
    const user = userEvent.setup()
    deleteWorktree.mockResolvedValue(ok())
    wrap(modal())
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    expect(await screen.findByText("Remove worktree directory")).toBeInTheDocument()
    expect(screen.getByText("Release port range")).toBeInTheDocument()
  })

  it("offers Force under the failed stage, and re-posts with the matching flag", async () => {
    const user = userEvent.setup()
    deleteWorktree
      .mockResolvedValueOnce({
        ok: false,
        needs_force: "remove_directory",
        steps: [{
          key: "remove_directory", label: "Remove worktree directory",
          status: "needs_force", detail: "fatal: could not remove",
        }],
      } as DeleteWorktreeResponse)
      .mockResolvedValueOnce(ok())
    wrap(modal())
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    // git's own words are shown, not a generic message.
    expect(await screen.findByText(/could not remove/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /force/i }))

    await waitFor(() => expect(deleteWorktree).toHaveBeenCalledTimes(2))
    expect(deleteWorktree.mock.calls[1][0]).toMatchObject({ force_directory: true })
  })

  it("re-posts with delete_branch:false on Cancel when the branch needs force, instead of closing", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    deleteWorktree
      .mockResolvedValueOnce({
        ok: false,
        needs_force: "delete_branch",
        steps: [
          { key: "remove_directory", label: "Remove worktree directory", status: "done" },
          { key: "delete_branch", label: "Delete branch", status: "needs_force", detail: "not fully merged" },
        ],
      } as DeleteWorktreeResponse)
      .mockResolvedValueOnce(ok())
    wrap(modal({ onClose }))
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    const checkbox = screen.getByRole("checkbox", { name: /delete the branch/i })
    await user.click(checkbox)
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    await screen.findByText(/not fully merged/)
    await user.click(screen.getByRole("button", { name: /^cancel$/i }))

    // Declining must finish cleanup, not just close: remove_directory has
    // already run by the time the branch escalates, so closing here would
    // strand the port range, registry row, resources and kubeconfig.
    await waitFor(() => expect(deleteWorktree).toHaveBeenCalledTimes(2))
    expect(deleteWorktree.mock.calls[1][0]).toMatchObject({ path: "/wt/foo", delete_branch: false })
    expect(deleteWorktree.mock.calls[1][0]).not.toHaveProperty("force_branch")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("still closes on Cancel when the DIRECTORY needs force, since nothing has been deleted yet", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    deleteWorktree.mockResolvedValueOnce({
      ok: false,
      needs_force: "remove_directory",
      steps: [{
        key: "remove_directory", label: "Remove worktree directory",
        status: "needs_force", detail: "fatal: could not remove",
      }],
    } as DeleteWorktreeResponse)
    wrap(modal({ onClose }))
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    await screen.findByText(/could not remove/)
    await user.click(screen.getByRole("button", { name: /^cancel$/i }))

    expect(onClose).toHaveBeenCalled()
    expect(deleteWorktree).toHaveBeenCalledTimes(1)
  })

  it("stays open on success and only navigates when OK is clicked", async () => {
    const user = userEvent.setup()
    const onDeleted = vi.fn()
    deleteWorktree.mockResolvedValue(ok())
    wrap(modal({ onDeleted }))
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    // The summary is the only report the user gets — it must not vanish.
    expect(await screen.findByRole("button", { name: /^ok$/i })).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: /^ok$/i }))
    expect(onDeleted).toHaveBeenCalled()
  })

  it("keeps the step list visible when the run fails outright", async () => {
    const user = userEvent.setup()
    deleteWorktree.mockResolvedValue({
      ok: false, needs_force: "", error: "not a worktree",
      steps: [{ key: "remove_directory", label: "Remove worktree directory", status: "failed", detail: "not a worktree" }],
    } as DeleteWorktreeResponse)
    wrap(modal())
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    expect(await screen.findByText("Remove worktree directory")).toBeInTheDocument()
    expect(screen.getByText(/not a worktree/)).toBeInTheDocument()
  })

  it("still shows a top-level error that differs from every step's detail", async () => {
    const user = userEvent.setup()
    deleteWorktree.mockResolvedValue({
      ok: false, needs_force: "", error: "delete run aborted unexpectedly",
      steps: [{ key: "remove_directory", label: "Remove worktree directory", status: "failed", detail: "fatal: could not remove" }],
    } as DeleteWorktreeResponse)
    wrap(modal())
    await user.type(screen.getByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))

    expect(await screen.findByText(/could not remove/)).toBeInTheDocument()
    expect(screen.getByText(/aborted unexpectedly/)).toBeInTheDocument()
  })

  it("resets to a fresh confirmation form when reopened", async () => {
    const user = userEvent.setup()
    deleteWorktree.mockResolvedValue(ok())
    const { rerender } = wrap(modal({ opened: false }))
    rerender(
      <MantineProvider>
        {modal()}
      </MantineProvider>,
    )
    await user.type(await screen.findByLabelText(/type the worktree name/i), "foo")
    await user.click(screen.getByRole("button", { name: /^delete$/i }))
    await screen.findByRole("button", { name: /^ok$/i })

    // Close and reopen: the previous run's results must not still be showing.
    rerender(
      <MantineProvider>
        {modal({ opened: false })}
      </MantineProvider>,
    )
    rerender(
      <MantineProvider>
        {modal()}
      </MantineProvider>,
    )

    const nameInput = await screen.findByLabelText(/type the worktree name/i) as HTMLInputElement
    expect(nameInput.value).toBe("")
    expect(screen.getByRole("checkbox", { name: /delete the branch/i })).not.toBeChecked()
    expect(screen.queryByRole("button", { name: /^ok$/i })).not.toBeInTheDocument()
  })
})
