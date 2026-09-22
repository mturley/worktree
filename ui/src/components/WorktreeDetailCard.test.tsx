import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WorktreeDetailCard } from "./WorktreeDetailCard"
import type { WorktreeInfo, WorktreeSummary } from "../api/types"

const worktreeInfo = vi.fn()
const worktreeNotes = vi.fn()
const saveWorktreeNotes = vi.fn()
const cmux = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      worktreeInfo: (...a: unknown[]) => worktreeInfo(...a),
      worktreeNotes: (...a: unknown[]) => worktreeNotes(...a),
      saveWorktreeNotes: (...a: unknown[]) => saveWorktreeNotes(...a),
      cmux: (...a: unknown[]) => cmux(...a),
    },
  }
})

beforeEach(() => {
  worktreeNotes.mockResolvedValue({ notes: "", sync_cmux: false })
  saveWorktreeNotes.mockImplementation(async (args: { notes: string; sync_cmux: boolean }) => ({
    notes: args.notes, sync_cmux: args.sync_cmux, updated_at: "2026-09-21T00:00:00Z",
    cmux_sync: args.sync_cmux ? "ok" : "off",
  }))
  cmux.mockResolvedValue({ available: true, matches: {} })
})

const summary = (o: Partial<WorktreeSummary> = {}): WorktreeSummary => ({
  path: "/wt/foo", repo: "odh", branch: "my-branch", on_disk: true,
  resource_count: 2, primary_count: 1, latest_event_ts: "2026-08-25T00:00:00Z",
  primary_by_type: { pr: 1 }, related_count: 1,
  focus_resources: [
    { type: "pr", id: "o/r#1", url: "u", primary: true, title: "Focus PR title" },
  ],
  ...o,
}) as WorktreeSummary

const wrap = (w: WorktreeSummary) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <WorktreeDetailCard w={w} />
      </QueryClientProvider>
    </MantineProvider>,
  )

afterEach(() => {
  cleanup()
  for (const m of [worktreeInfo, worktreeNotes, saveWorktreeNotes, cmux]) m.mockReset()
})

const info = (o: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  env: [
    { key: "WORKTREE_PORTS", value: "4090-4099" },
    { key: "KUBECONFIG", value: "/home/u/.kube/config-foo" },
  ],
  git: { branch: "my-branch", upstream: "origin/my-branch", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0 },
  ...o,
})

describe("WorktreeDetailCard", () => {
  it("keeps the environment collapsed until asked", async () => {
    // These are long absolute paths that wrap to several lines each and push
    // the resource list and timeline below the fold. Note the assertion is
    // toBeVisible, NOT toBeInTheDocument: Mantine's Collapse keeps its
    // children mounted, so presence in the DOM proves nothing here.
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    const toggle = await screen.findByRole("button", { name: /show environment variables/i })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByText("4090-4099")).not.toBeVisible()
  })

  it("names how many variables there are, so the toggle is worth clicking", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    expect(await screen.findByText("Environment (2)")).toBeInTheDocument()
  })

  it("reveals the environment worktree info prints when expanded", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await userEvent.click(await screen.findByRole("button", { name: /show environment variables/i }))
    expect(screen.getByText("4090-4099")).toBeVisible()
    expect(screen.getByText("/home/u/.kube/config-foo")).toBeVisible()
  })

  it("copies a variable's value, without its name", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
    wrap(summary())
    await user.click(await screen.findByRole("button", { name: /show environment/i }))
    await user.click(screen.getByRole("button", { name: "Copy KUBECONFIG" }))
    expect(writeText).toHaveBeenCalledWith("/home/u/.kube/config-foo")
  })

  it("collapses again on a second click", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await userEvent.click(await screen.findByRole("button", { name: /show environment/i }))
    await userEvent.click(screen.getByRole("button", { name: /hide environment/i }))
    expect(screen.getByText("4090-4099")).not.toBeVisible()
  })

  it("never lists focus resources, which the resource cards below already show", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await screen.findByText("Environment (2)")
    expect(screen.queryByText("Focus PR title")).not.toBeInTheDocument()
  })

  it("summarises a dirty tree, counting staged/modified/untracked separately", async () => {
    worktreeInfo.mockResolvedValue(info({
      git: { branch: "b", ahead: 0, behind: 0, staged: 2, modified: 3, untracked: 1 },
    }))
    wrap(summary())
    expect(await screen.findByText(/2 staged · 3 modified · 1 untracked/)).toBeInTheDocument()
  })

  it("reports ahead/behind even when the tree is clean", async () => {
    // A branch with unpushed commits is not the same as one in sync, so
    // "clean" alone would hide something worth seeing.
    worktreeInfo.mockResolvedValue(info({
      git: { branch: "b", ahead: 2, behind: 1, staged: 0, modified: 0, untracked: 0 },
    }))
    wrap(summary())
    expect(await screen.findByText(/clean · ahead 2 · behind 1/)).toBeInTheDocument()
  })

  it("still renders the repo and branch when the info request fails", async () => {
    // A worktree missing from disk, or git unavailable, must not blank the card.
    worktreeInfo.mockRejectedValue(new Error("boom"))
    wrap(summary())
    await waitFor(() => expect(screen.getByText(/odh · my-branch/)).toBeInTheDocument())
  })

  it("leaves the worktree name to the page header", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await screen.findByText("Environment (2)")
    expect(screen.queryByText("foo")).not.toBeInTheDocument()
    expect(screen.queryByText("WORKTREE")).not.toBeInTheDocument()
  })
})

describe("delete control", () => {
  it("opens the delete modal from the trash control", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("button", { name: /delete worktree/i }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    // The typed-name confirmation is the safeguard; it must be present.
    expect(screen.getByLabelText(/type the worktree name/i)).toBeInTheDocument()
  })

  it("does not delete anything just by opening the modal", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("button", { name: /delete worktree/i }))
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeDisabled()
  })
})

describe("layout", () => {
  it("puts the git status on the same line as the branch", async () => {
    worktreeInfo.mockResolvedValue(info({
      git: { branch: "my-branch", ahead: 0, behind: 0, staged: 0, modified: 3, untracked: 0 },
    }))
    wrap(summary())
    const status = await screen.findByText(/3 modified/)
    expect(status.closest("p")).toHaveTextContent(/odh · my-branch · 3 modified/)
  })

  it("lets only one of Environment and Notes be open at a time", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("button", { name: /show environment/i }))
    expect(screen.getByText("4090-4099")).toBeVisible()
    await user.click(screen.getByRole("button", { name: /show notes/i }))
    expect(await screen.findByText("No notes yet")).toBeVisible()
    expect(screen.getByText("4090-4099")).not.toBeVisible()
    expect(screen.getByRole("button", { name: /show environment/i })).toHaveAttribute("aria-expanded", "false")
  })
})

const notesBox = () => screen.getByRole("textbox", { name: /worktree notes/i })

/** Opens the Notes section if needed, then clicks "Edit notes". */
async function startEditing(user: ReturnType<typeof userEvent.setup>) {
  // hidden: the section may still be collapsed, which hides its contents.
  const edit = await screen.findByRole("button", { name: /edit notes/i, hidden: true })
  await waitFor(() => expect(edit).toBeEnabled())
  const toggle = screen.getByRole("button", { name: /(show|hide) notes/i })
  if (toggle.getAttribute("aria-expanded") === "false") await user.click(toggle)
  await user.click(edit)
  return notesBox()
}

describe("notes", () => {

  it("starts collapsed, with no dot, when there are no notes", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    const toggle = await screen.findByRole("button", { name: /show notes/i })
    await waitFor(() => expect(worktreeNotes).toHaveBeenCalled())
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("notes-dot")).not.toBeInTheDocument()
  })

  it("starts expanded when there are notes", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "waiting on review", sync_cmux: false })
    wrap(summary())
    expect(await screen.findByText("waiting on review")).toBeVisible()
  })

  it("shows a dot on the collapsed toggle when there are notes", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "waiting on review", sync_cmux: false })
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("button", { name: /hide notes/i }))
    expect(screen.getByTestId("notes-dot")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /show notes \(has notes\)/i })).toBeInTheDocument()
  })

  it("auto-saves after typing pauses, walking unsaved → saving → saved", async () => {
    worktreeInfo.mockResolvedValue(info())
    let resolve!: () => void
    saveWorktreeNotes.mockImplementation((args: { notes: string; sync_cmux: boolean }) =>
      new Promise((r) => { resolve = () => r({ ...args, cmux_sync: "off" }) }))
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await user.type(notesBox(), "hi")
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
    // One save for the whole burst, not one per keystroke.
    await screen.findByText("Saving…", {}, { timeout: 2000 })
    expect(saveWorktreeNotes).toHaveBeenCalledTimes(1)
    expect(saveWorktreeNotes.mock.calls[0][0]).toEqual({ path: "/wt/foo", notes: "hi", sync_cmux: false })
    resolve()
    expect(await screen.findByText("Saved")).toBeInTheDocument()
  })

  it("offers Retry when a save fails, and drops it once a retry succeeds", async () => {
    worktreeInfo.mockResolvedValue(info())
    saveWorktreeNotes.mockRejectedValueOnce(new Error("disk full"))
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await user.type(notesBox(), "x")
    expect(await screen.findByText(/save failed: disk full/i, {}, { timeout: 2000 })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("Saved")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()
    expect(saveWorktreeNotes).toHaveBeenCalledTimes(2)
  })

  it("shows the saved notes, not the first-loaded ones, after navigating away and back", async () => {
    // One QueryClient for the whole app, as in production: the card unmounts
    // and remounts, but the query cache survives.
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "old", sync_cmux: false })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const tree = () => (
      <MantineProvider>
        <QueryClientProvider client={client}>
          <WorktreeDetailCard w={summary()} />
        </QueryClientProvider>
      </MantineProvider>
    )
    const user = userEvent.setup()
    const view = render(tree())
    expect(await startEditing(user)).toHaveValue("old")
    await user.type(notesBox(), " new")
    expect(await screen.findByText("Saved", {}, { timeout: 2000 })).toBeInTheDocument()
    view.unmount()

    // The server now has the new notes, but may answer slowly: what shows
    // first must already be the saved text, not the stale first load.
    worktreeNotes.mockImplementation(() => new Promise(() => {}))
    render(tree())
    expect(await screen.findByText("old new")).toBeInTheDocument()
  })

  it("ignores a refetch older than the last save, but adopts a newer one", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "old", sync_cmux: false, updated_at: "2026-09-21T00:00:00Z" })
    saveWorktreeNotes.mockImplementation(async (args: { notes: string; sync_cmux: boolean }) => ({
      ...args, updated_at: "2026-09-22T00:00:00Z", cmux_sync: "off",
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(
      <MantineProvider>
        <QueryClientProvider client={client}>
          <WorktreeDetailCard w={summary()} />
        </QueryClientProvider>
      </MantineProvider>,
    )
    expect(await startEditing(user)).toHaveValue("old")
    await user.type(notesBox(), " new")
    expect(await screen.findByText("Saved", {}, { timeout: 2000 })).toBeInTheDocument()

    // A refetch that started before the save and answers after it.
    await client.refetchQueries({ queryKey: ["worktree-notes", "/wt/foo"] })
    expect(notesBox()).toHaveValue("old new")

    // An edit made on another device since.
    worktreeNotes.mockResolvedValue({ notes: "from phone", sync_cmux: false, updated_at: "2026-09-23T00:00:00Z" })
    await client.refetchQueries({ queryKey: ["worktree-notes", "/wt/foo"] })
    await waitFor(() => expect(notesBox()).toHaveValue("from phone"))
  })

  it("is read-only until Edit notes, rendering Markdown", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "**blocked** on [PR](https://example.com/pr)\n\n- [ ] rebase", sync_cmux: false })
    wrap(summary())
    expect(await screen.findByText("blocked")).toContainHTML("<strong>blocked</strong>")
    const link = screen.getByRole("link", { name: "PR" })
    expect(link).toHaveAttribute("href", "https://example.com/pr")
    expect(link).toHaveAttribute("target", "_blank")
    expect(screen.getByRole("checkbox", { name: "" })).toBeDisabled()
    expect(screen.queryByRole("textbox", { name: /worktree notes/i })).not.toBeInTheDocument()
  })

  it("never renders raw HTML typed into the notes", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "<img src=x onerror=alert(1)> hi", sync_cmux: false })
    const { container } = wrap(summary())
    await screen.findByText(/hi/)
    expect(container.querySelector("img")).toBeNull()
  })

  it("says so when there are no notes", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("button", { name: /show notes/i }))
    expect(await screen.findByText("No notes yet")).toBeVisible()
  })

  it("Done editing saves pending edits and returns to the rendered view", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    const box = await startEditing(user)
    expect(box).toHaveFocus()
    await user.type(box, "*done*")
    await user.click(screen.getByRole("button", { name: /done editing/i }))
    // Sent now, not after the debounce.
    expect(saveWorktreeNotes).toHaveBeenCalledWith({ path: "/wt/foo", notes: "*done*", sync_cmux: false })
    expect(screen.queryByRole("textbox", { name: /worktree notes/i })).not.toBeInTheDocument()
    expect(screen.getByText("done").tagName).toBe("EM")
  })

  it("Esc also ends editing", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("textbox", { name: /worktree notes/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /edit notes/i })).toBeInTheDocument()
  })

  it("comes back read-only after collapsing mid-edit", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await user.click(screen.getByRole("button", { name: /hide notes/i }))
    await user.click(screen.getByRole("button", { name: /show notes/i }))
    expect(screen.queryByRole("textbox", { name: /worktree notes/i })).not.toBeInTheDocument()
  })

  it("saves pending edits immediately when the notes are collapsed", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await user.type(notesBox(), "x")
    await user.click(screen.getByRole("button", { name: /hide notes/i }))
    expect(saveWorktreeNotes).toHaveBeenCalledTimes(1)
  })
})

describe("cmux description sync", () => {
  const oneWorkspace = { available: true, matches: { "/wt/foo": [{ ref: "workspace:1", title: "foo", selected: false }] } }
  const syncBox = () => screen.queryByRole("checkbox", { name: /sync to cmux workspace description/i })

  it("is offered, unchecked, when exactly one workspace matches", async () => {
    worktreeInfo.mockResolvedValue(info())
    cmux.mockResolvedValue(oneWorkspace)
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await waitFor(() => expect(syncBox()).toBeInTheDocument())
    expect(syncBox()).not.toBeChecked()
  })

  it("is hidden until editing", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "existing", sync_cmux: false })
    cmux.mockResolvedValue(oneWorkspace)
    wrap(summary())
    await screen.findByText("existing")
    await waitFor(() => expect(cmux).toHaveBeenCalled())
    expect(syncBox()).not.toBeInTheDocument()
  })

  it("is not offered with zero or two workspaces", async () => {
    worktreeInfo.mockResolvedValue(info())
    cmux.mockResolvedValue({
      available: true,
      matches: { "/wt/foo": [
        { ref: "workspace:1", title: "a", selected: false },
        { ref: "workspace:2", title: "b", selected: false },
      ] },
    })
    const user = userEvent.setup()
    wrap(summary())
    await waitFor(() => expect(cmux).toHaveBeenCalled())
    await startEditing(user)
    expect(syncBox()).not.toBeInTheDocument()
  })

  it("pushes the current notes as soon as it is checked", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "existing", sync_cmux: false })
    cmux.mockResolvedValue(oneWorkspace)
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await waitFor(() => expect(syncBox()).toBeEnabled())
    await user.click(syncBox()!)
    await waitFor(() => expect(saveWorktreeNotes).toHaveBeenCalledWith({ path: "/wt/foo", notes: "existing", sync_cmux: true }))
    expect(await screen.findByText("Saved · synced to cmux")).toBeInTheDocument()
  })

  it("offers Retry when the cmux sync fails, though the notes saved", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "existing", sync_cmux: true })
    cmux.mockResolvedValue(oneWorkspace)
    saveWorktreeNotes.mockResolvedValueOnce({ notes: "existing!", sync_cmux: true, cmux_sync: "failed", cmux_error: "no" })
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await user.type(notesBox(), "!")
    expect(await screen.findByText("Saved · cmux sync failed", {}, { timeout: 2000 })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByText("Saved · synced to cmux")).toBeInTheDocument()
  })

  it("stays visible, with a reason, if sync is on but the workspace is gone", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "existing", sync_cmux: true })
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await waitFor(() => expect(syncBox()).toBeChecked())
    expect(screen.getByText(/not syncing: this worktree has no cmux workspace/i)).toBeInTheDocument()
  })
})
