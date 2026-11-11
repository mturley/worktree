import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider, Modal } from "@mantine/core"
import { Notifications, notifications } from "@mantine/notifications"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../../api/client"
import type { ResourceDTO, TaskDetail, TimelineEvent } from "../../../api/types"
import { TaskModalHeader } from "./TaskModalHeader"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: {
    taskActivity: vi.fn(),
    taskUnread: vi.fn(),
    taskRead: vi.fn(),
    taskReadRestore: vi.fn(),
    markResourceRead: vi.fn(),
    restoreResourceRead: vi.fn(),
    globalTimeline: vi.fn(),
    worktreeTimeline: vi.fn(),
  },
}))

const detail = (extra: Partial<TaskDetail> = {}): TaskDetail => ({
  id: 5, ref: "T5", title: "task 5", description: "", state: "not_started", priority: "none", starred: false,
  rank: "r", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-21T00:00:00Z", archived: false,
  links: [], implicit_worktrees: [], subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, open_blockers: [],
  detail_links: [], implicit: [], subtasks: [], event_links: [], blockers: [], blocks: [], linked_resources: [], ...extra,
})

const row = (id: string, extra: Partial<TimelineEvent>) =>
  ({ id, ts: "2099-03-01T00:00:00Z", type: "pr_comment", type_label: "", title: id, body: "", author: "",
     source: "github", external_ts: "", resource_type: "pr", resource_id: "o/r#1", resource_url: "u",
     resource_title: "", worktrees: [], ...extra }) as unknown as TimelineEvent

const unreadPR = { type: "pr", id: "o/r#1", url: "u", primary: true, unread_count: 2,
  unread_through_ts: "2099-03-02T00:00:00Z" } as ResourceDTO

let qc: QueryClient
function wrap(task: TaskDetail) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={qc}>
        {/* The title is a Modal.Title, which needs a modal around it. */}
        <Modal.Root opened onClose={() => {}}>
          <Modal.Content>
            <TaskModalHeader task={task} onUpdate={() => {}} onState={() => {}} onClose={() => {}} />
          </Modal.Content>
        </Modal.Root>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => {
  vi.mocked(api.taskActivity).mockResolvedValue({
    events: [
      row("pr unread", { unread: true }),
      row("pr read", { unread: false }),
      row("task unread", { unread: true, source: "tasks", type: "task_comment", resource_type: "task", resource_id: "5" }),
    ],
    next_cursor: "",
  })
  vi.mocked(api.taskUnread).mockResolvedValue([{ id: 5, title: "task 5", count: 1, newest_ts: "2099-03-03T00:00:00Z" }])
  vi.mocked(api.taskRead).mockImplementation(async (a) => ({ previous_ts: "2099-01-01T00:00:00Z", last_read_ts: a.through_ts }))
  vi.mocked(api.taskReadRestore).mockResolvedValue(null)
  vi.mocked(api.markResourceRead).mockImplementation(async (a) => ({ previous_ts: "2099-01-01T00:00:00Z", last_read_ts: a.through_ts }))
  vi.mocked(api.restoreResourceRead).mockResolvedValue(null)
})
afterEach(() => {
  cleanup()
  notifications.clean()
  vi.clearAllMocks()
})

describe("TaskModalHeader Mark all read", () => {
  const unread = () => detail({ unread_count: 1, combined_unread_count: 3, linked_resources: [unreadPR] })
  const openIt = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: /Mark all read/ }))
    return screen.findByRole("dialog", { name: "Mark all read" })
  }

  it("is absent while the combined count is 0", async () => {
    wrap(detail({ unread_count: 0, combined_unread_count: 0 }))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole("button", { name: /Mark all read/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Mark read" })).not.toBeInTheDocument()
  })

  it("shows while only linked resources are unread, and never marks anything just by rendering", async () => {
    wrap(detail({ unread_count: 0, combined_unread_count: 2, linked_resources: [unreadPR] }))
    expect(await screen.findByRole("button", { name: /Mark all read/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Mark read" })).not.toBeInTheDocument()
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(api.taskRead).not.toHaveBeenCalled()
    expect(api.markResourceRead).not.toHaveBeenCalled()
  })

  it("lists the linked GitHub events and the task itself, both checked, and marks both", async () => {
    const user = userEvent.setup()
    wrap(unread())
    const dialog = await openIt(user)
    expect(api.taskUnread).toHaveBeenCalledWith({ kind: "task", id: 5 })
    expect(within(dialog).getByRole("checkbox", { name: "Mark 2 GitHub events in 1 PR as read" })).toBeChecked()
    expect(await within(dialog).findByRole("checkbox", { name: "T5 task 5" })).toBeChecked()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    await user.click(within(dialog).getByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(api.taskRead).toHaveBeenCalledWith({ id: 5, through_ts: "2099-03-03T00:00:00Z" }))
    expect(api.markResourceRead).toHaveBeenCalledWith({ type: "pr", id: "o/r#1", through_ts: "2099-03-02T00:00:00Z" })
    expect(await screen.findByText("Marked 2 GitHub events, 1 task event read")).toBeInTheDocument()
    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey))
    expect(keys).toContain('["tasks"]')
  })

  it("leaves the linked resource's cursor alone when it is unchecked", async () => {
    const user = userEvent.setup()
    wrap(unread())
    const dialog = await openIt(user)
    await within(dialog).findByRole("checkbox", { name: "T5 task 5" })
    await user.click(within(dialog).getByRole("checkbox", { name: /GitHub/ }))
    await user.click(within(dialog).getByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(api.taskRead).toHaveBeenCalledTimes(1))
    expect(api.markResourceRead).not.toHaveBeenCalled()
  })

  it("previews the task's unread activity only, from its own feed", async () => {
    const user = userEvent.setup()
    wrap(unread())
    const dialog = await openIt(user)
    expect(await within(dialog).findByText("pr unread")).toBeInTheDocument()
    expect(await within(dialog).findByText("task unread")).toBeInTheDocument()
    expect(within(dialog).queryByText("pr read")).toBeNull()
    expect(api.taskActivity).toHaveBeenCalledWith(5, "all", undefined, undefined)
    expect(api.globalTimeline).not.toHaveBeenCalled()
    expect(api.worktreeTimeline).not.toHaveBeenCalled()
  })
})

describe("TaskModalHeader Open in full UI", () => {
  const post = vi.fn()
  afterEach(() => {
    delete window.webkit
    post.mockReset()
    window.history.replaceState({}, "", "/")
  })

  it("hints that Esc closes the task", () => {
    wrap(detail())
    const close = screen.getByRole("button", { name: "Close task" })
    expect(close).toHaveTextContent("Esc")
  })

  it("sits beside the close button in the mini view, and opens the task in its worktree", async () => {
    window.webkit = { messageHandlers: { worktree: { postMessage: post } } }
    window.history.replaceState({}, "", "/mini")
    wrap(detail({ implicit_worktrees: ["/wt/a"] }))
    const button = screen.getByRole("button", { name: /Open in full UI/ })
    expect(button.nextElementSibling).toBe(screen.getByRole("button", { name: "Close task" }))
    await userEvent.click(button)
    expect(post).toHaveBeenCalledWith({ type: "open", url: `${window.location.origin}/worktree/%2Fwt%2Fa?task=5` })
  })

  it("isn't offered in the full UI", () => {
    wrap(detail())
    expect(screen.queryByRole("button", { name: /Open in full UI/ })).not.toBeInTheDocument()
  })
})

describe("TaskModalHeader id", () => {
  it("shows the task's id beside the close button, as links and blockers name it", () => {
    wrap(detail())
    const id = screen.getByText("T5")
    expect(id.nextElementSibling).toBe(screen.getByRole("button", { name: "Close task" }))
  })
})
