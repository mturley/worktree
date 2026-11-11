import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { api } from "../../../api/client"
import type { TaskDetailLink, TaskEventLink, TimelineEvent } from "../../../api/types"
import { ActivityTab } from "./ActivityTab"
import { detail, renderDetail } from "./detailsTestUtils"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: { taskDetail: vi.fn(), taskActivity: vi.fn(), linkTaskEvent: vi.fn(), unlinkTaskEvent: vi.fn() },
}))

const ev = (o: Partial<TimelineEvent>): TimelineEvent => ({
  id: "1", ts: "2026-10-20T00:00:00Z", external_ts: "", source: "github", type: "pr_comment", type_label: "",
  title: "an event", body: "", author: "alice", resource_type: "pr", resource_id: "o/r#1",
  resource_url: "", resource_title: "", worktrees: [], ...o,
})

const prLink: TaskDetailLink = {
  kind: "resource", resource_type: "pr", resource_id: "o/r#1", focus: true, archived: false, title: "Fix login",
}
const slackLink: TaskDetailLink = {
  kind: "resource", resource_type: "slack", resource_id: "C1:100.000", focus: false, archived: false, title: "A thread",
}
const wtLink: TaskDetailLink = { kind: "worktree", worktree: "/w/feat", focus: false, archived: false, title: "feat" }

const slackEventLink: TaskEventLink = {
  key: "slack:C1:200.000",
  snapshot: {
    source: "slack", type: "slack_reply", title: "hi", author: "bob", body: "hi", url: "", ts: "",
    resource_type: "slack", resource_id: "C1:100.000",
  },
}

const base = detail({ detail_links: [prLink, slackLink, wtLink], links: [prLink, slackLink, wtLink], event_links: [slackEventLink] })

const events = [
  ev({ id: "task:5", source: "tasks", type: "task_created", title: "Task created", resource_type: "task", resource_id: "task:1" }),
  ev({ id: "a1111111-1111-4111-8111-111111111111", title: "Comment one" }),
  ev({ id: "a2222222-2222-4222-8222-222222222222", title: "Linked comment", linked_to_task: true, linked_key: "ev:a2222222-2222-4222-8222-222222222222" }),
  ev({
    id: "a3333333-3333-4333-8333-333333333333", title: "Slack reply", source: "slack", type: "slack_reply", resource_type: "slack",
    resource_id: "C1:100.000", external_ts: "200.000", linked_to_task: true, linked_key: "slack:C1:200.000",
  }),
  // A link with no live event: the server built this row from its snapshot.
  ev({
    id: "slack:C9:7.7", title: "Gone message", source: "slack", type: "slack_reply", resource_type: "slack",
    resource_id: "C9:7.0", linked_to_task: true, linked_key: "slack:C9:7.7",
  }),
]

beforeEach(() => {
  vi.mocked(api.taskDetail).mockResolvedValue(base)
  vi.mocked(api.taskActivity).mockResolvedValue({ events, next_cursor: "2026-10-20T00:00:00Z" })
  vi.mocked(api.linkTaskEvent).mockResolvedValue(base)
  vi.mocked(api.unlinkTaskEvent).mockResolvedValue(base)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const show = () => renderDetail(base, (d) => <ActivityTab task={d} />)

describe("ActivityTab", () => {
  it("shows everything by default", async () => {
    show()
    expect(await screen.findByText("Comment one")).toBeInTheDocument()
    expect(screen.getByText("Task created")).toBeInTheDocument()
    expect(api.taskActivity).toHaveBeenCalledWith(1, "all", undefined, undefined)
  })

  it("a row click opens its details over the task, without Make task", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByText("Comment one"))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Comment one")).toBeInTheDocument()
    expect(within(dialog).queryByRole("button", { name: "Make task" })).toBeNull()
  })

  it("a link toggle click does not open details", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Link event: Comment one" }))
    await waitFor(() => expect(api.linkTaskEvent).toHaveBeenCalled())
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("this task's own event row opens its details, not the task again", async () => {
    window.history.replaceState({}, "", "/")
    vi.mocked(api.taskActivity).mockResolvedValue({
      events: [ev({ id: "task:9", source: "tasks", type: "task_renamed", title: "Renamed it", resource_type: "task", resource_id: "1" })],
      next_cursor: "",
    })
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByText("Renamed it"))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Renamed it")).toBeInTheDocument()
    expect(window.location.search).toBe("")
  })

  it("opens with initialEvent's details shown", async () => {
    renderDetail(base, (d) => <ActivityTab task={d} initialEvent={events[1]} />)
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Comment one")).toBeInTheDocument()
  })

  it("the pills change the activity filter, one per linked resource", async () => {
    const user = userEvent.setup()
    show()
    await screen.findByText("Comment one")
    expect(screen.getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true")
    await user.click(screen.getByRole("button", { name: "This task only" }))
    await waitFor(() => expect(api.taskActivity).toHaveBeenCalledWith(1, "task", undefined, undefined))
    expect(screen.getByRole("button", { name: "This task only" })).toHaveAttribute("aria-pressed", "true")
    await user.click(screen.getByRole("button", { name: "Linked events" }))
    await waitFor(() => expect(api.taskActivity).toHaveBeenCalledWith(1, "linked", undefined, undefined))
    await user.click(screen.getByRole("button", { name: "A thread" }))
    await waitFor(() =>
      expect(api.taskActivity).toHaveBeenCalledWith(1, "resource", { type: "slack", rid: "C1:100.000" }, undefined),
    )
    // Worktrees are not resources: no pill.
    expect(screen.queryByRole("button", { name: "feat" })).toBeNull()
  })

  it("links a resource event by its ev: key", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Link event: Comment one" }))
    expect(api.linkTaskEvent).toHaveBeenCalledWith(1, "ev:a1111111-1111-4111-8111-111111111111", undefined)
  })

  it("unlinks a linked event by its ev: key", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Unlink event: Linked comment" }))
    expect(api.unlinkTaskEvent).toHaveBeenCalledWith(1, "ev:a2222222-2222-4222-8222-222222222222")
  })

  it("unlinks a Slack message by the key the server says it is linked under", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Unlink event: Slack reply" }))
    expect(api.unlinkTaskEvent).toHaveBeenCalledWith(1, "slack:C1:200.000")
  })

  it("a snapshot row can be unlinked, by its link key", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Unlink event: Gone message" }))
    expect(api.unlinkTaskEvent).toHaveBeenCalledWith(1, "slack:C9:7.7")
  })

  it("the task's own events have no link toggle", async () => {
    show()
    await screen.findByText("Task created")
    expect(screen.queryByRole("button", { name: /event: Task created/ })).toBeNull()
  })

  it("a full page offers the feeds' Load more, which asks for the rows before its cursor and appends them", async () => {
    const full = Array.from({ length: 200 }, (_, i) =>
      ev({ id: `full-${i}`, title: `Row ${i}`, ts: "2026-10-20T00:00:00Z" }))
    vi.mocked(api.taskActivity)
      .mockResolvedValueOnce({ events: full, next_cursor: "2026-10-20T00:00:00Z" })
      .mockResolvedValueOnce({ events: [ev({ id: "older", title: "Older row", ts: "2026-10-19T00:00:00Z" })], next_cursor: "2026-10-19T00:00:00Z" })
    const user = userEvent.setup()
    show()
    await screen.findByText("Row 199")
    await user.click(screen.getByRole("button", { name: "Load more" }))
    await waitFor(() => expect(api.taskActivity).toHaveBeenLastCalledWith(1, "all", undefined, "2026-10-20T00:00:00Z"))
    expect(await screen.findByText("Older row")).toBeInTheDocument()
    expect(screen.getByText("Row 0")).toBeInTheDocument()
    // A short page is the end.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull()
  })

  it("a short page offers no Load more", async () => {
    show()
    await screen.findByText("Comment one")
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull()
  })

  it("a failed link says why", async () => {
    vi.mocked(api.linkTaskEvent).mockRejectedValue(new Error("boom"))
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Link event: Comment one" }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
  })
})
