import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, screen, waitFor } from "@testing-library/react"
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
  ev({ id: "a2222222-2222-4222-8222-222222222222", title: "Linked comment", linked_to_task: true }),
  ev({
    id: "a3333333-3333-4333-8333-333333333333", title: "Slack reply", source: "slack", type: "slack_reply", resource_type: "slack",
    resource_id: "C1:100.000", external_ts: "200.000", linked_to_task: true,
  }),
]

beforeEach(() => {
  vi.mocked(api.taskDetail).mockResolvedValue(base)
  vi.mocked(api.taskActivity).mockResolvedValue(events)
  vi.mocked(api.linkTaskEvent).mockResolvedValue(base)
  vi.mocked(api.unlinkTaskEvent).mockResolvedValue(base)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const show = () => renderDetail(base, (d) => <ActivityTab task={d} />)

describe("ActivityTab", () => {
  it("shows everything by default, as inert rows", async () => {
    show()
    expect(await screen.findByText("Comment one")).toBeInTheDocument()
    expect(screen.getByText("Task created")).toBeInTheDocument()
    expect(api.taskActivity).toHaveBeenCalledWith(1, "all", undefined)
    expect(document.querySelector("[data-event-row][data-clickable]")).toBeNull()
  })

  it("the pills change the activity filter, one per linked resource", async () => {
    const user = userEvent.setup()
    show()
    await screen.findByText("Comment one")
    expect(screen.getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true")
    await user.click(screen.getByRole("button", { name: "This task only" }))
    await waitFor(() => expect(api.taskActivity).toHaveBeenCalledWith(1, "task", undefined))
    expect(screen.getByRole("button", { name: "This task only" })).toHaveAttribute("aria-pressed", "true")
    await user.click(screen.getByRole("button", { name: "Linked events" }))
    await waitFor(() => expect(api.taskActivity).toHaveBeenCalledWith(1, "linked", undefined))
    await user.click(screen.getByRole("button", { name: "A thread" }))
    await waitFor(() =>
      expect(api.taskActivity).toHaveBeenCalledWith(1, "resource", { type: "slack", rid: "C1:100.000" }),
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

  it("unlinks a Slack message by the key it was linked under", async () => {
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Unlink event: Slack reply" }))
    expect(api.unlinkTaskEvent).toHaveBeenCalledWith(1, "slack:C1:200.000")
  })

  it("the task's own events have no link toggle", async () => {
    show()
    await screen.findByText("Task created")
    expect(screen.queryByRole("button", { name: /event: Task created/ })).toBeNull()
  })

  it("a failed link says why", async () => {
    vi.mocked(api.linkTaskEvent).mockRejectedValue(new Error("boom"))
    const user = userEvent.setup()
    show()
    await user.click(await screen.findByRole("button", { name: "Link event: Comment one" }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
  })
})
