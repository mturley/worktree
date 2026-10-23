import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider, Modal } from "@mantine/core"
import { Notifications, notifications } from "@mantine/notifications"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../../api/client"
import type { TaskDetail, TimelineEvent } from "../../../api/types"
import { TaskModalHeader } from "./TaskModalHeader"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: {
    taskActivity: vi.fn(),
    taskRead: vi.fn(),
    taskReadRestore: vi.fn(),
  },
}))

const detail = (extra: Partial<TaskDetail> = {}): TaskDetail => ({
  id: 5, ref: "T5", title: "task 5", description: "", state: "not_started", priority: "none", starred: false,
  rank: "r", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-21T00:00:00Z", archived: false,
  links: [], implicit_worktrees: [], subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [],
  detail_links: [], implicit: [], subtasks: [], event_links: [], blockers: [], blocks: [], ...extra,
})

const taskEv = (id: string, ts: string) =>
  ({ id, ts, type: "task_comment", type_label: "", title: id, body: "", author: "", source: "tasks",
     external_ts: "", resource_type: "task", resource_id: "5", resource_url: "", resource_title: "task 5",
     worktrees: [] }) as unknown as TimelineEvent

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
  // A newer event than any test's unread_through_ts: Mark read must not use it.
  vi.mocked(api.taskActivity).mockResolvedValue([
    taskEv("task:3", "2099-03-03T00:00:00Z"),
    taskEv("task:2", "2099-03-02T00:00:00Z"),
  ])
  vi.mocked(api.taskRead).mockImplementation(async (a) => ({ previous_ts: "2099-01-01T00:00:00Z", last_read_ts: a.through_ts }))
  vi.mocked(api.taskReadRestore).mockResolvedValue(null)
})
afterEach(() => {
  cleanup()
  notifications.clean()
  vi.clearAllMocks()
})

describe("TaskModalHeader Mark read", () => {
  it("is absent while the task has nothing unread", () => {
    wrap(detail({ unread_count: 0 }))
    expect(screen.queryByRole("button", { name: "Mark read" })).not.toBeInTheDocument()
  })

  it("never marks anything just by rendering", async () => {
    wrap(detail({ unread_count: 2 }))
    expect(screen.getByRole("button", { name: "Mark read" })).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 20))
    expect(api.taskRead).not.toHaveBeenCalled()
  })

  it("marks through the rendered unread_through_ts, even with a newer event since, and undoes it", async () => {
    // The activity holds a newer event (03-03) than the one the header counted
    // through (03-02): an agent event that arrived after render stays unread.
    const user = userEvent.setup()
    wrap(detail({ unread_count: 2, unread_through_ts: "2099-03-02T00:00:00Z" }))
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(api.taskRead).toHaveBeenCalledWith({ id: 5, through_ts: "2099-03-02T00:00:00Z" }))
    expect(api.taskActivity).not.toHaveBeenCalled()
    expect(await screen.findByText("Marked 2 task events read")).toBeInTheDocument()
    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey))
    for (const k of ['["tasks"]', '["worktrees"]', '["resources"]', '["timeline"]']) expect(keys).toContain(k)

    await user.click(screen.getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(api.taskReadRestore).toHaveBeenCalledWith({
      id: 5, previous_ts: "2099-01-01T00:00:00Z", last_read_ts: "2099-03-02T00:00:00Z",
    }))
  })

  it("says Already read when the mark moves nothing", async () => {
    vi.mocked(api.taskRead).mockResolvedValue({ previous_ts: "2099-03-09T00:00:00Z", last_read_ts: "2099-03-09T00:00:00Z" })
    const user = userEvent.setup()
    wrap(detail({ unread_count: 1, unread_through_ts: "2099-03-02T00:00:00Z" }))
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    expect(await screen.findByText("Already read")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument()
  })

  it("says Already read, writing nothing, without an unread_through_ts", async () => {
    const user = userEvent.setup()
    wrap(detail({ unread_count: 1 }))
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    expect(await screen.findByText("Already read")).toBeInTheDocument()
    expect(api.taskRead).not.toHaveBeenCalled()
  })

  it("reports a failed mark", async () => {
    vi.mocked(api.taskRead).mockRejectedValue(new Error("task gone"))
    const user = userEvent.setup()
    wrap(detail({ unread_count: 1, unread_through_ts: "2099-03-02T00:00:00Z" }))
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    expect(await screen.findByText(/Couldn't mark read: task gone/)).toBeInTheDocument()
  })
})
