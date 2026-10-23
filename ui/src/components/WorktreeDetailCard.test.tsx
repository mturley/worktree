import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WorktreeDetailCard } from "./WorktreeDetailCard"
import { useDetailTab } from "../hooks/useDetailTab"
import type { WorktreeGit, WorktreeInfo, WorktreeSummary } from "../api/types"

/** The card with its tab state wired up the way the page does it. */
function Card({ w }: { w: WorktreeSummary }) {
  const { tab, select } = useDetailTab(w.path, false)
  return <WorktreeDetailCard w={w} tab={tab} onTabChange={select} />
}

const worktreeInfo = vi.fn()
const worktreeGit = vi.fn()
const worktreeNotes = vi.fn()
const saveWorktreeNotes = vi.fn()
const cmux = vi.fn()
const cmuxTree = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      worktreeInfo: (...a: unknown[]) => worktreeInfo(...a),
      worktreeGit: (...a: unknown[]) => worktreeGit(...a),
      worktreeNotes: (...a: unknown[]) => worktreeNotes(...a),
      saveWorktreeNotes: (...a: unknown[]) => saveWorktreeNotes(...a),
      cmux: (...a: unknown[]) => cmux(...a),
      cmuxTree: (...a: unknown[]) => cmuxTree(...a),
    },
  }
})

beforeEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
  worktreeGit.mockResolvedValue(gitStatus())
  worktreeNotes.mockResolvedValue({ notes: "", sync_cmux: false })
  saveWorktreeNotes.mockImplementation(async (args: { notes: string; sync_cmux: boolean; show_on_home: boolean }) => ({
    notes: args.notes, sync_cmux: args.sync_cmux, show_on_home: args.show_on_home, updated_at: "2026-09-21T00:00:00Z",
    cmux_sync: args.sync_cmux ? "ok" : "off",
  }))
  cmux.mockResolvedValue({ available: true, matches: {} })
  cmuxTree.mockResolvedValue({ available: true, workspaces: [] })
})

const gitStatus = (o: Partial<WorktreeGit> = {}): WorktreeGit => ({
  on_disk: true, fingerprint: "f", working_fingerprint: "wf", branch: "my-branch",
  main_upstream: "upstream/main", merge_base: "76ef50c1234567890abcdef1234567890abcdef12",
  vs_merge_base: { ahead: 0, behind: 0 },
  tracking: "origin/my-branch", vs_tracking: { ahead: 0, behind: 0 },
  working: { staged: 0, modified: 0, untracked: 0, files: 0 },
  fetch: { last_ok_at: new Date().toISOString(), in_progress: false },
  ...o,
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
        <Card w={w} />
      </QueryClientProvider>
    </MantineProvider>,
  )

/** The rendered notes' task-list checkboxes, not the card's own settings. */
const taskBoxes = () => Array.from(document.querySelectorAll<HTMLInputElement>(".worktree-notes input[type=checkbox]"))

/** The value beside a git row label, e.g. rowValue("Branch"). */
const rowValue = (label: string) => screen.getByText(label).nextElementSibling?.textContent

afterEach(() => {
  cleanup()
  for (const m of [worktreeInfo, worktreeGit, worktreeNotes, saveWorktreeNotes, cmux, cmuxTree]) m.mockReset()
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
  it("starts on the Notes tab, with the environment hidden", async () => {
    // Note the assertion is toBeVisible, NOT toBeInTheDocument: Mantine's
    // Tabs keep inactive panels mounted, so presence in the DOM proves nothing.
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    const env = await screen.findByRole("tab", { name: /environment/i })
    expect(env).toHaveAttribute("aria-selected", "false")
    expect(screen.getByRole("tab", { name: /notes/i })).toHaveAttribute("aria-selected", "true")
    expect(await screen.findByText("4090-4099")).not.toBeVisible()
  })

  it("keeps the Environment tab when there is no environment, saying so", async () => {
    worktreeInfo.mockResolvedValue(info({ env: [] }))
    const user = userEvent.setup()
    wrap(summary())
    await waitFor(() => expect(worktreeInfo).toHaveBeenCalled())
    await user.click(await screen.findByRole("tab", { name: "Environment" }))
    expect(await screen.findByText("None")).toBeVisible()
  })

  it("reveals the environment worktree info prints on the Environment tab", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await userEvent.click(await screen.findByRole("tab", { name: /environment/i }))
    expect(screen.getByText("4090-4099")).toBeVisible()
    expect(screen.getByText("/home/u/.kube/config-foo")).toBeVisible()
  })

  it("copies a variable's value, without its name", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
    wrap(summary())
    await user.click(await screen.findByRole("tab", { name: /environment/i }))
    await user.click(screen.getByRole("button", { name: "Copy KUBECONFIG" }))
    expect(writeText).toHaveBeenCalledWith("/home/u/.kube/config-foo")
  })

  it("hides the environment again on returning to Notes", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await userEvent.click(await screen.findByRole("tab", { name: /environment/i }))
    await userEvent.click(screen.getByRole("tab", { name: /notes/i }))
    expect(screen.getByText("4090-4099")).not.toBeVisible()
  })

  it("never lists focus resources, which the resource cards below already show", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await screen.findByText("4090-4099")
    expect(screen.queryByText("Focus PR title")).not.toBeInTheDocument()
  })

  it("leaves the worktree name to the page header", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await screen.findByText("4090-4099")
    expect(screen.queryByText("foo")).not.toBeInTheDocument()
    expect(screen.queryByText("WORKTREE")).not.toBeInTheDocument()
  })
})

const openCode = async () => userEvent.click(await screen.findByRole("tab", { name: /^Code/ }))

describe("tabs", () => {
  it("orders them Notes, Environment, Code, cmux", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await screen.findByRole("tab", { name: "cmux" })
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Notes", "Environment", "Code", "cmux"])
  })
})

describe("Code tab badge", () => {
  it("shows ahead, behind and changed files for the merge base", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({
      vs_merge_base: { ahead: 8, behind: 12 },
      working: { staged: 0, modified: 4, untracked: 0, files: 4 },
    }))
    wrap(summary())
    expect(await screen.findByText("↑8 ↓12 · 4")).toBeVisible()
  })

  it("is absent when every number is zero", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await waitFor(() => expect(worktreeGit).toHaveBeenCalled())
    expect(screen.getByRole("tab", { name: "Code" })).toBeVisible()
    expect(screen.queryByText(/↑/)).toBeNull()
  })

  it("counts against the remembered tracking base", async () => {
    window.localStorage.setItem("worktree.diffSelection:/wt/foo", JSON.stringify({ base: "tracking", range: "all" }))
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({
      vs_merge_base: { ahead: 8, behind: 12 },
      vs_tracking: { ahead: 3, behind: 0 },
    }))
    wrap(summary())
    expect(await screen.findByText("↑3 ↓0")).toBeVisible()
  })
})

describe("Code tab summary", () => {
  it("lays out the left column's rows, with yellow only when dirty", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({ working: { staged: 2, modified: 3, untracked: 1, files: 6 } }))
    wrap(summary())
    await openCode()
    expect(await screen.findByText("2 staged · 3 modified · 1 untracked")).toBeVisible()
    expect(rowValue("Repo")).toBe("odh")
    expect(rowValue("Branch")).toBe("my-branch")
    expect(rowValue("Updated")).toMatch(/ago$/)
  })

  it("says clean for a clean tree", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await openCode()
    expect(await screen.findByText("clean")).toBeVisible()
  })

  it("puts ahead/behind on its own line under the merge base", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({ vs_merge_base: { ahead: 8, behind: 12 } }))
    wrap(summary())
    await openCode()
    expect(await screen.findByText("upstream/main @ 76ef50c")).toBeVisible()
    const line = screen.getByText("8 ahead · 12 behind")
    expect(line.textContent).toBe("8 ahead · 12 behind")
    const mergeBaseRow = screen.getByText("Merge base").parentElement!
    expect(mergeBaseRow.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(mergeBaseRow).not.toContainElement(line)
  })

  it("explains an unavailable merge base", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({ merge_base: undefined, main_upstream: undefined, vs_merge_base: undefined }))
    wrap(summary())
    await openCode()
    expect(await screen.findByText("main has no upstream")).toBeVisible()
  })

  it("says the branch is not pushed, with no ahead/behind line, when there is no tracking branch", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({ tracking: undefined, vs_tracking: undefined }))
    wrap(summary())
    await openCode()
    expect(await screen.findByText("none (not pushed)")).toBeVisible()
    // Only the merge base's line remains.
    expect(screen.getAllByText(/ahead · .* behind/)).toHaveLength(1)
  })

  it("flags a failed fetch with a warning icon", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({ fetch: { last_ok_at: null, last_error: "network down", in_progress: false } }))
    wrap(summary())
    await openCode()
    expect(await screen.findByLabelText("Last fetch failed")).toBeVisible()
  })

  it("says the worktree is missing from disk", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({ on_disk: false }))
    wrap(summary())
    await openCode()
    expect(await screen.findByText("Worktree is missing from disk")).toBeVisible()
  })

  it("asks the server to fetch only while the Code tab is open", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await waitFor(() => expect(worktreeGit).toHaveBeenCalledWith("/wt/foo", false))
    await openCode()
    await waitFor(() => expect(worktreeGit).toHaveBeenCalledWith("/wt/foo", true))
  })
})

describe("layout", () => {
  it("puts the delete control after the tabs, outside the tab list", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    const tablist = await screen.findByRole("tablist")
    const del = screen.getByRole("button", { name: "Delete worktree" })
    expect(tablist).not.toContainElement(del)
    expect(tablist.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("puts the Notes tab before the Environment tab", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    const env = await screen.findByRole("tab", { name: /environment/i })
    const notes = screen.getByRole("tab", { name: /notes/i })
    expect(notes.compareDocumentPosition(env) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("shows only one of Environment and Notes at a time", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("tab", { name: /environment/i }))
    expect(screen.getByText("4090-4099")).toBeVisible()
    expect(screen.getByText("No notes yet")).not.toBeVisible()
    await user.click(screen.getByRole("tab", { name: /notes/i }))
    expect(await screen.findByText("No notes yet")).toBeVisible()
    expect(screen.getByText("4090-4099")).not.toBeVisible()
  })
})

const notesBox = () => screen.getByRole("textbox", { name: /worktree notes/i })

/** Clicks "Edit notes" (Notes is the default tab). */
async function startEditing(user: ReturnType<typeof userEvent.setup>) {
  const edit = await screen.findByRole("button", { name: /edit notes/i })
  await waitFor(() => expect(edit).toBeEnabled())
  await user.click(edit)
  return notesBox()
}

describe("notes", () => {

  it("shows the notes when there are notes", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "waiting on review", sync_cmux: false })
    wrap(summary())
    expect(await screen.findByText("waiting on review")).toBeVisible()
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
    expect(saveWorktreeNotes.mock.calls[0][0]).toEqual({ path: "/wt/foo", notes: "hi", sync_cmux: false, show_on_home: true })
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
          <Card w={summary()} />
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
          <Card w={summary()} />
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
    expect(screen.queryByRole("textbox", { name: /worktree notes/i })).not.toBeInTheDocument()
  })

  it("shows the home page checkbox checked by default, saving at once when cleared", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "existing", sync_cmux: false })
    const user = userEvent.setup()
    wrap(summary())
    await screen.findByText("existing")
    // Like the cmux sync checkbox, only offered while editing.
    expect(screen.queryByRole("checkbox", { name: "Show notes on home page" })).toBeNull()
    await startEditing(user)
    const box = screen.getByRole("checkbox", { name: "Show notes on home page" })
    await waitFor(() => expect(box).toBeEnabled())
    expect(box).toBeChecked()
    await user.click(box)
    await waitFor(() => expect(saveWorktreeNotes).toHaveBeenCalledWith({ path: "/wt/foo", notes: "existing", sync_cmux: false, show_on_home: false }))
    expect(box).not.toBeChecked()
  })

  it("reflects a stored show_on_home of false", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "existing", sync_cmux: false, show_on_home: false })
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    const box = screen.getByRole("checkbox", { name: "Show notes on home page" })
    await waitFor(() => expect(box).toBeEnabled())
    expect(box).not.toBeChecked()
  })

  it("checks a task from the read-only view, saving just that change at once", async () => {
    worktreeInfo.mockResolvedValue(info())
    const notes = "todo:\n\n- [ ] rebase\n  - [x] nested done\n> 1. [ ] quoted"
    worktreeNotes.mockResolvedValue({ notes, sync_cmux: false })
    const user = userEvent.setup()
    wrap(summary())
    await screen.findByText("rebase")
    const [top, nested, quoted] = taskBoxes()
    expect(top).not.toBeChecked()
    expect(nested).toBeChecked()

    await user.click(top)
    // Immediately, not after the typing debounce.
    expect(saveWorktreeNotes).toHaveBeenCalledTimes(1)
    expect(saveWorktreeNotes).toHaveBeenLastCalledWith({
      path: "/wt/foo", notes: notes.replace("- [ ] rebase", "- [x] rebase"), sync_cmux: false, show_on_home: true,
    })
    await waitFor(() => expect(taskBoxes()[0]).toBeChecked())
    expect(await screen.findByText("Saved")).toBeInTheDocument()

    await user.click(nested)
    await waitFor(() => expect(saveWorktreeNotes).toHaveBeenLastCalledWith({
      path: "/wt/foo",
      notes: notes.replace("- [ ] rebase", "- [x] rebase").replace("- [x] nested", "- [ ] nested"),
      sync_cmux: false, show_on_home: true,
    }))
    await user.click(quoted)
    await waitFor(() => expect(saveWorktreeNotes.mock.lastCall?.[0].notes).toContain("> 1. [x] quoted"))
    // Still read-only throughout.
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
    wrap(summary())
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
    expect(saveWorktreeNotes).toHaveBeenCalledWith({ path: "/wt/foo", notes: "*done*", sync_cmux: false, show_on_home: true })
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

  it("comes back read-only after switching tabs mid-edit", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await user.click(screen.getByRole("tab", { name: /environment/i }))
    await user.click(screen.getByRole("tab", { name: /notes/i }))
    expect(screen.queryByRole("textbox", { name: /worktree notes/i })).not.toBeInTheDocument()
  })

  it("saves pending edits immediately when leaving the Notes tab", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await user.type(notesBox(), "x")
    await user.click(screen.getByRole("tab", { name: /environment/i }))
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
    await waitFor(() => expect(saveWorktreeNotes).toHaveBeenCalledWith({ path: "/wt/foo", notes: "existing", sync_cmux: true, show_on_home: true }))
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

  it("is hidden when cmux is unavailable or turned off, even with sync on", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeNotes.mockResolvedValue({ notes: "existing", sync_cmux: true })
    cmux.mockResolvedValue({ available: false })
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await waitFor(() => expect(cmux).toHaveBeenCalled())
    expect(screen.queryByLabelText(/sync to cmux/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/not syncing/i)).not.toBeInTheDocument()
  })
})

describe("cmux tab", () => {
  it("comes after Environment when cmux is available", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    const cmuxTab = await screen.findByRole("tab", { name: "cmux" })
    const env = screen.getByRole("tab", { name: /environment/i })
    expect(env.compareDocumentPosition(cmuxTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("is absent outside cmux", async () => {
    worktreeInfo.mockResolvedValue(info())
    cmux.mockResolvedValue({ available: false })
    wrap(summary())
    await screen.findByRole("tab", { name: /environment/i })
    await waitFor(() => expect(cmux).toHaveBeenCalled())
    expect(screen.queryByRole("tab", { name: "cmux" })).not.toBeInTheDocument()
  })

  it("mounts the panel only while selected", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("tab", { name: "cmux" }))
    expect(await screen.findByText(/no cmux workspace/i)).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: /notes/i }))
    expect(screen.queryByText(/no cmux workspace/i)).not.toBeInTheDocument()
  })

  // The page isn't remounted between worktrees (only the card is keyed), so
  // these rerender the same hook with another path.
  const tree = (client: QueryClient, w: WorktreeSummary) => (
    <MantineProvider>
      <QueryClientProvider client={client}>
        <Card w={w} />
      </QueryClientProvider>
    </MantineProvider>
  )
  const selected = (name: RegExp) => expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true")

  it("opens the next worktree on Notes, not the tab chosen for the last one", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(tree(client, summary()))
    await user.click(await screen.findByRole("tab", { name: /environment/i }))
    selected(/environment/i)
    rerender(tree(client, summary({ path: "/wt/bar" })))
    await waitFor(() => selected(/notes/i))
  })

  it("opens every worktree on the cmux tab while following cmux", async () => {
    window.sessionStorage.setItem("worktree.followCmuxFocus", "true")
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(tree(client, summary()))
    await waitFor(() => selected(/cmux/i))
    await user.click(screen.getByRole("tab", { name: /environment/i }))
    rerender(tree(client, summary({ path: "/wt/bar" })))
    await waitFor(() => selected(/cmux/i))
  })

  it("opens on Notes while following cmux when cmux isn't there", async () => {
    window.sessionStorage.setItem("worktree.followCmuxFocus", "true")
    worktreeInfo.mockResolvedValue(info())
    cmux.mockResolvedValue({ available: false })
    wrap(summary())
    await waitFor(() => expect(cmux).toHaveBeenCalled())
    await waitFor(() => selected(/notes/i))
  })

  it("falls back to Notes if cmux goes away while its tab is selected", async () => {
    worktreeInfo.mockResolvedValue(info())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(
      <MantineProvider>
        <QueryClientProvider client={client}>
          <Card w={summary()} />
        </QueryClientProvider>
      </MantineProvider>,
    )
    await user.click(await screen.findByRole("tab", { name: "cmux" }))
    cmux.mockResolvedValue({ available: false })
    await client.invalidateQueries({ queryKey: ["cmux"] })
    await waitFor(() => expect(screen.queryByRole("tab", { name: "cmux" })).not.toBeInTheDocument())
    expect(screen.getByRole("tab", { name: /notes/i })).toHaveAttribute("aria-selected", "true")
    expect(await screen.findByText("No notes yet")).toBeVisible()

    // cmux comes back: the card must not jump back to the cmux tab just
    // because it exists again — the user is on Notes now.
    cmux.mockResolvedValue({ available: true, matches: {} })
    await client.invalidateQueries({ queryKey: ["cmux"] })
    await screen.findByRole("tab", { name: "cmux" })
    expect(screen.getByRole("tab", { name: /notes/i })).toHaveAttribute("aria-selected", "true")
  })
})

describe("returning to Notes", () => {
  it("clicking the active tab again goes back to Notes", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("tab", { name: /environment/i }))
    expect(screen.getByRole("tab", { name: /environment/i })).toHaveAttribute("aria-selected", "true")
    await user.click(screen.getByRole("tab", { name: /environment/i }))
    expect(screen.getByRole("tab", { name: /notes/i })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: /environment/i })).toHaveAttribute("aria-selected", "false")
  })

  it("clicking an inactive tab still selects it", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("tab", { name: /environment/i }))
    await openCode()
    expect(screen.getByRole("tab", { name: /^Code/ })).toHaveAttribute("aria-selected", "true")
  })

  it("clicking Notes while on Notes leaves it there, still editing", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await user.click(screen.getByRole("tab", { name: /notes/i }))
    expect(screen.getByRole("tab", { name: /notes/i })).toHaveAttribute("aria-selected", "true")
    expect(notesBox()).toBeInTheDocument()
  })

  it("flushes a notes edit when the tab leaves Notes and is clicked back", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await startEditing(user)
    await user.type(notesBox(), "x")
    await user.click(screen.getByRole("tab", { name: /environment/i }))
    expect(saveWorktreeNotes).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("tab", { name: /environment/i }))
    expect(screen.getByRole("tab", { name: /notes/i })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("textbox", { name: /worktree notes/i })).not.toBeInTheDocument()
  })

  it("shows a Back to notes button only off Notes, just before the delete control", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await screen.findByRole("tab", { name: /environment/i })
    expect(screen.queryByRole("button", { name: "Back to notes" })).toBeNull()
    await openCode()
    const back = screen.getByRole("button", { name: "Back to notes" })
    const del = screen.getByRole("button", { name: "Delete worktree" })
    expect(back.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.click(back)
    expect(screen.getByRole("tab", { name: /notes/i })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("button", { name: "Back to notes" })).toBeNull()
  })
})

describe("Code tab badge cursor", () => {
  it("shows a pointer over the badge, like the rest of the tab", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({ vs_merge_base: { ahead: 2, behind: 0 } }))
    wrap(summary())
    const badge = await screen.findByText("↑2 ↓0")
    expect(badge.closest(".mantine-Badge-root")).toHaveStyle({ cursor: "pointer" })
  })
})

describe("Code tab badge color", () => {
  const badgeStyle = async (text: string) =>
    (await screen.findByText(text)).closest(".mantine-Badge-root")!.getAttribute("style") ?? ""

  it("is yellow with uncommitted changes", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({
      vs_tracking: { ahead: 2, behind: 0 },
      working: { staged: 0, modified: 1, untracked: 0, files: 1 },
    }))
    wrap(summary())
    expect(await badgeStyle("↑0 ↓0 · 1")).toMatch(/yellow/)
  })

  it("is orange with unpushed commits", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({ vs_merge_base: { ahead: 2, behind: 0 }, vs_tracking: { ahead: 2, behind: 0 } }))
    wrap(summary())
    expect(await badgeStyle("↑2 ↓0")).toMatch(/orange/)
  })

  it("stays gray when everything is pushed", async () => {
    worktreeInfo.mockResolvedValue(info())
    worktreeGit.mockResolvedValue(gitStatus({ vs_merge_base: { ahead: 2, behind: 0 } }))
    wrap(summary())
    expect(await badgeStyle("↑2 ↓0")).toMatch(/gray/)
  })
})
