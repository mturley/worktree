import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { api, HttpError } from "../../../api/client"
import type { ResourceDTO, Task, TaskBlocker, TaskDetailLink } from "../../../api/types"
import { BlockersSection } from "./BlockersSection"
import { detail, renderDetail } from "./detailsTestUtils"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: {
    taskDetail: vi.fn(),
    tasks: vi.fn(),
    worktrees: vi.fn(),
    worktreeResources: vi.fn(),
    allResources: vi.fn(),
    addTaskBlocker: vi.fn(),
    removeTaskBlocker: vi.fn(),
    resolveTaskBlocker: vi.fn(),
  },
}))

const blocker = (b: Partial<TaskBlocker> & Pick<TaskBlocker, "id" | "kind" | "label">): TaskBlocker => ({
  status_label: "", resolved: false, resolved_auto: false, resolved_reason: "", manual_resolvable: false, ...b,
})

const taskBlocker = blocker({ id: 11, kind: "task", label: "T4 Ship the API", task_id: 4, status_label: "in_progress" })
const prBlocker = blocker({
  id: 12, kind: "resource", label: "Fix login", url: "https://github.com/o/r/pull/9", resource_type: "pr",
  resource_id: "o/r#9", status_label: "merged", resolved: true, resolved_auto: true, resolved_reason: "merged",
})
const otherBlocker = blocker({ id: 13, kind: "other", label: "Legal sign-off", text: "Legal sign-off", manual_resolvable: true })
const slackBlocker = blocker({
  id: 14, kind: "resource", label: "Design thread", resource_type: "slack", resource_id: "C1:1.1",
  url: "https://slack/x", status_label: "resolved", resolved: true, manual_resolvable: true,
})

const wtLink: TaskDetailLink = { kind: "worktree", worktree: "/w/feat", focus: true, archived: false, title: "feat" }

// Given resolved and unresolved mixed: the section lists unresolved first.
const base = detail({
  blocked: true, blocker_count: 2,
  blockers: [prBlocker, taskBlocker, slackBlocker, otherBlocker],
  blocks: [{ id: 2, ref: "T2", title: "Downstream", state: "not_started" }],
  detail_links: [wtLink], links: [wtLink],
})

const t = (id: number, title: string, extra: Partial<Task> = {}): Task => ({
  id, ref: `T${id}`, title, description: "", state: "not_started", priority: "none", starred: false, rank: "r",
  created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [], subtasks_total: 0,
  subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [], ...extra,
})
const res = (id: string, title: string): ResourceDTO => ({ type: "pr", id, url: `https://x/${id}`, primary: false, title })

const originalScroll = Element.prototype.scrollIntoView
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  window.history.replaceState({}, "", "/?task=1")
  vi.mocked(api.taskDetail).mockResolvedValue(base)
  vi.mocked(api.tasks).mockResolvedValue([
    t(1, "task 1"), t(2, "Downstream"), t(3, "Open candidate"), t(4, "Ship the API"),
    t(5, "Finished one", { state: "done" }),
  ])
  vi.mocked(api.worktrees).mockResolvedValue([])
  vi.mocked(api.worktreeResources).mockResolvedValue([res("o/r#1", "Fix logout")])
  vi.mocked(api.allResources).mockResolvedValue([])
  vi.mocked(api.addTaskBlocker).mockResolvedValue(base)
  vi.mocked(api.removeTaskBlocker).mockResolvedValue(base)
  vi.mocked(api.resolveTaskBlocker).mockResolvedValue(base)
})
afterEach(() => {
  Element.prototype.scrollIntoView = originalScroll
  cleanup()
  vi.clearAllMocks()
})

const rows = () => screen.getAllByTestId("blocker-row")

async function startAdding(kind: "Task" | "Resource" | "Other") {
  const user = userEvent.setup()
  renderDetail(base, (d) => <BlockersSection task={d} />)
  await user.click(screen.getByRole("button", { name: "+ Add" }))
  await user.click(await screen.findByRole("menuitem", { name: kind }))
  return user
}

describe("BlockersSection", () => {
  it("lists unresolved blockers first, each with its status; resolved ones dimmed with a check, never red", () => {
    renderDetail(base, (d) => <BlockersSection task={d} />)
    expect(screen.getByText("Blocked by")).toBeInTheDocument()
    const r = rows()
    expect(r.map((e) => e.dataset.blockerId)).toEqual(["11", "13", "12", "14"])
    expect(r[0]).toHaveTextContent("T4 Ship the API")
    expect(r[0]).toHaveTextContent("in_progress")
    expect(r[0]).not.toHaveAttribute("data-resolved")
    expect(r[2]).toHaveTextContent("Fix login")
    expect(r[2]).toHaveTextContent("merged")
    expect(r[2]).toHaveAttribute("data-resolved", "true")
    expect(within(r[2]).getByLabelText("resolved")).toHaveTextContent("✓")
    expect(r[2].style.opacity).toBe("0.6")
  })

  it("opens a resource blocker's URL in a new tab", () => {
    renderDetail(base, (d) => <BlockersSection task={d} />)
    const link = screen.getByRole("link", { name: "Fix login" })
    expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/9")
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("opens a task blocker's task in the modal, replacing the history entry", async () => {
    const user = userEvent.setup()
    const before = window.history.length
    renderDetail(base, (d) => <BlockersSection task={d} />)
    await user.click(screen.getByRole("button", { name: "T4 Ship the API" }))
    expect(new URLSearchParams(window.location.search).get("task")).toBe("4")
    expect(window.history.length).toBe(before)
  })

  it("offers the manual resolve checkbox only where allowed", async () => {
    const user = userEvent.setup()
    renderDetail(base, (d) => <BlockersSection task={d} />)
    expect(screen.getByRole("checkbox", { name: "Resolved: Legal sign-off" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Resolved: Design thread" })).toBeChecked()
    expect(screen.queryByRole("checkbox", { name: "Resolved: T4 Ship the API" })).toBeNull()
    expect(screen.queryByRole("checkbox", { name: "Resolved: Fix login" })).toBeNull()
    await user.click(screen.getByRole("checkbox", { name: "Resolved: Legal sign-off" }))
    expect(api.resolveTaskBlocker).toHaveBeenCalledWith(13, true)
    await user.click(screen.getByRole("checkbox", { name: "Resolved: Design thread" }))
    expect(api.resolveTaskBlocker).toHaveBeenCalledWith(14, false)
    // Neither control opens the task blocker's task.
    expect(new URLSearchParams(window.location.search).get("task")).toBe("1")
  })

  it("removes a blocker without opening its task", async () => {
    const user = userEvent.setup()
    renderDetail(base, (d) => <BlockersSection task={d} />)
    await user.click(screen.getByRole("button", { name: "Remove blocker T4 Ship the API" }))
    expect(api.removeTaskBlocker).toHaveBeenCalledWith(11)
    expect(new URLSearchParams(window.location.search).get("task")).toBe("1")
  })

  it("shows a failed remove inline", async () => {
    vi.mocked(api.removeTaskBlocker).mockRejectedValue(new Error("nope"))
    const user = userEvent.setup()
    renderDetail(base, (d) => <BlockersSection task={d} />)
    await user.click(screen.getByRole("button", { name: "Remove blocker Legal sign-off" }))
    expect(await screen.findByText(/nope/)).toBeInTheDocument()
  })

  it("adds a task blocker from open tasks, less itself, what it blocks and what already blocks it", async () => {
    const user = await startAdding("Task")
    const input = screen.getByRole("textbox", { name: "Blocking task" })
    await user.click(input)
    expect(await screen.findByRole("option", { name: /Open candidate/ })).toBeInTheDocument()
    expect(api.tasks).toHaveBeenCalledWith({ kind: "all" }, { completed: false, archived: false })
    for (const gone of [/task 1/, /Downstream/, /Ship the API/, /Finished one/]) {
      expect(screen.queryByRole("option", { name: gone })).toBeNull()
    }
    await user.click(screen.getByRole("option", { name: /Open candidate/ }))
    await waitFor(() => expect(api.addTaskBlocker).toHaveBeenCalledWith(1, { kind: "task", task_id: 3 }))
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Blocking task" })).toBeNull())
  })

  it("shows a cycle error inline and keeps the picker open", async () => {
    vi.mocked(api.addTaskBlocker).mockRejectedValue(
      new HttpError("invalid task input: would create a blocking cycle", 400),
    )
    const user = await startAdding("Task")
    const input = screen.getByRole("textbox", { name: "Blocking task" })
    await user.click(input)
    await user.click(await screen.findByRole("option", { name: /Open candidate/ }))
    expect(await screen.findByText(/would create a blocking cycle/)).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Blocking task" })).toBeInTheDocument()
  })

  it("adds a resource blocker from the task's worktrees' resources", async () => {
    const user = await startAdding("Resource")
    await user.click(screen.getByRole("textbox", { name: "Blocking resource" }))
    await user.click(await screen.findByRole("option", { name: /Fix logout/ }))
    await waitFor(() =>
      expect(api.addTaskBlocker).toHaveBeenCalledWith(1, { kind: "resource", type: "pr", rid: "o/r#1" }),
    )
    expect(api.worktreeResources).toHaveBeenCalledWith("/w/feat")
  })

  it("adds a resource blocker from a pasted URL", async () => {
    const user = await startAdding("Resource")
    const input = screen.getByRole("textbox", { name: "Blocking resource" })
    await user.click(input)
    await user.type(input, "https://github.com/o/r/pull/77{Enter}")
    await waitFor(() =>
      expect(api.addTaskBlocker).toHaveBeenCalledWith(1, { kind: "resource", url: "https://github.com/o/r/pull/77" }),
    )
  })

  it("adds an other blocker from its text", async () => {
    const user = await startAdding("Other")
    const input = screen.getByRole("textbox", { name: "Blocker text" })
    await user.type(input, "  Waiting on legal  {Enter}")
    await waitFor(() => expect(api.addTaskBlocker).toHaveBeenCalledWith(1, { kind: "other", text: "Waiting on legal" }))
  })

  it("says so when nothing blocks the task", () => {
    renderDetail(detail(), (d) => <BlockersSection task={d} />)
    expect(screen.getByText("Not blocked.")).toBeInTheDocument()
  })
})
