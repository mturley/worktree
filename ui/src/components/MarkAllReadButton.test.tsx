import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { fireEvent, render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { Notifications, notifications } from "@mantine/notifications"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO, TimelineEvent } from "../api/types"

const markResourceRead = vi.fn()
const restoreResourceRead = vi.fn()
const globalTimeline = vi.fn()
const worktreeTimeline = vi.fn()
const taskUnread = vi.fn()
const taskRead = vi.fn()
const taskReadRestore = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      markResourceRead: (...args: unknown[]) => markResourceRead(...args),
      restoreResourceRead: (...args: unknown[]) => restoreResourceRead(...args),
      globalTimeline: (...args: unknown[]) => globalTimeline(...args),
      worktreeTimeline: (...args: unknown[]) => worktreeTimeline(...args),
      taskUnread: (...args: unknown[]) => taskUnread(...args),
      taskRead: (...args: unknown[]) => taskRead(...args),
      taskReadRestore: (...args: unknown[]) => taskReadRestore(...args),
    },
  }
})
const markThreadRead = vi.fn()
const restoreThreadRead = vi.fn()
vi.mock("../api/slackApi", async (orig) => ({
  ...(await orig<typeof import("../api/slackApi")>()),
  markRead: (...args: unknown[]) => markThreadRead(...args),
  restoreRead: (...args: unknown[]) => restoreThreadRead(...args),
}))

import { MarkAllReadButton, type MarkAllReadFeed } from "./MarkAllReadButton"
import type { TaskScope } from "../api/types"

const ev = (id: string, resource_type: string, title: string): TimelineEvent =>
  ({ id, ts: "2099-01-01T00:00:00Z", type: "pr_comment", type_label: "", title, body: "", author: "",
     source: resource_type === "pr" ? "github" : resource_type, external_ts: "", resource_type,
     resource_id: `${resource_type}-1`, resource_url: "u", resource_title: "", worktrees: [], unread: true }) as TimelineEvent
const unreadEvents = [
  ev("e-pr", "pr", "a PR comment"),
  ev("e-jira", "jira", "a Jira comment"),
  ev("e-slack", "slack", "a Slack reply"),
]
// The server narrows by resource_types; so does this stand-in.
const feedFor = (types: string[] | undefined) =>
  Promise.resolve({ events: unreadEvents.filter((e) => !types?.length || types.includes(e.resource_type)), next_cursor: "" })

const pr = (id: string, n: number, through?: string): ResourceDTO =>
  ({ type: "pr", id, url: "u", primary: true, unread_count: n, unread_through_ts: through }) as ResourceDTO
const jira = (id: string, n: number, through?: string): ResourceDTO =>
  ({ type: "jira", id, url: "u", primary: true, unread_count: n, unread_through_ts: through }) as ResourceDTO
const slack = (id: string, n: number, latest = "1790000000.000100"): ResourceDTO =>
  ({ type: "slack", id, url: "u", primary: false, has_unread: n > 0, unread_count: n, updated_ts: latest }) as ResourceDTO

const wrap = (
  items: ResourceDTO[],
  feed: MarkAllReadFeed = {},
  opts: { taskScope?: TaskScope; single?: boolean } = {},
) =>
  render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarkAllReadButton
          resources={items}
          feed={feed}
          taskScope={opts.taskScope ?? { kind: "all" }}
          single={opts.single}
        />
      </QueryClientProvider>
    </MantineProvider>,
  )

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /mark all read/i }))
  await screen.findByRole("dialog")
}

// Braces, not an expression body: vitest calls a function RETURNED from
// beforeEach as teardown, and mockReset returns the mock itself.
beforeEach(() => {
  markResourceRead.mockReset()
  // Every mark moves its cursor forward from an earlier one.
  markResourceRead.mockImplementation((a: { through_ts: string }) =>
    Promise.resolve({ previous_ts: "2099-01-01T00:00:00Z", last_read_ts: a.through_ts }))
  restoreResourceRead.mockReset()
  restoreResourceRead.mockResolvedValue(null)
  markThreadRead.mockReset()
  markThreadRead.mockResolvedValue(undefined)
  restoreThreadRead.mockReset()
  restoreThreadRead.mockResolvedValue(undefined)
  globalTimeline.mockReset()
  globalTimeline.mockImplementation((_a, _l, _b, types?: string[]) => feedFor(types))
  worktreeTimeline.mockReset()
  worktreeTimeline.mockImplementation((_p, _l, _r, _b, types?: string[]) => feedFor(types))
  taskUnread.mockReset()
  taskUnread.mockResolvedValue([])
  taskRead.mockReset()
  taskRead.mockImplementation((a: { through_ts: string }) =>
    Promise.resolve({ previous_ts: "2099-01-01T00:00:00Z", last_read_ts: a.through_ts }))
  taskReadRestore.mockReset()
  taskReadRestore.mockResolvedValue(null)
})
afterEach(() => {
  cleanup()
  notifications.clean()
})

const everything = () => [
  pr("o/r#1", 2, "2099-01-02T00:00:00Z"),
  pr("o/r#2", 1, "2099-01-03T00:00:00Z"),
  pr("o/r#3", 0),
  jira("J-1", 3, "2099-01-05T00:00:00Z"),
  jira("J-2", 1, "2099-01-06T00:00:00Z"),
  slack("C1:1.2", 5, "1790000000.000100"),
  slack("C2:3.4", 7, "1790000009.000900"),
  slack("C3:5.6", 0),
]

describe("MarkAllReadButton", () => {
  it("renders nothing when nothing is unread", async () => {
    wrap([pr("o/r#1", 0), jira("J-1", 0), slack("C1:1.2", 0)])
    await waitFor(() => expect(taskUnread).toHaveBeenCalled())
    expect(screen.queryByRole("button", { name: /mark all read/i })).not.toBeInTheDocument()
  })

  it("counts a resource's own events only, not its tasks'", async () => {
    // unread_count includes task_unread_count; the tasks are marked through
    // their own cursors, so the resource's line counts only its own.
    const user = userEvent.setup()
    wrap([{ ...pr("o/r#1", 5, "2099-01-02T00:00:00Z"), task_unread_count: 3 } as ResourceDTO])
    await open(user)
    expect(screen.getByRole("checkbox", { name: "Mark 2 GitHub events in 1 PR as read" })).toBeInTheDocument()
  })

  it("lists each type with unreads, with its own counts, all checked", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    for (const name of [
      "Mark 3 GitHub events in 2 PRs as read",
      "Mark 4 Jira events in 2 issues as read",
      "Mark 12 Slack messages in 2 threads as read",
    ]) {
      expect(screen.getByRole("checkbox", { name })).toBeChecked()
    }
  })

  it("lists only the types that have unreads", async () => {
    const user = userEvent.setup()
    wrap([pr("o/r#1", 0), jira("J-1", 3, "2099-01-05T00:00:00Z"), slack("C1:1.2", 0)])
    await open(user)
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
    expect(screen.getByRole("checkbox", { name: "Mark 3 Jira events in 1 issue as read" })).toBeInTheDocument()
  })

  it("uses singular forms", async () => {
    const user = userEvent.setup()
    wrap([pr("o/r#1", 1, "2099-01-02T00:00:00Z"), jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", 1)])
    await open(user)
    for (const name of [
      "Mark 1 GitHub event in 1 PR as read",
      "Mark 1 Jira event in 1 issue as read",
      "Mark 1 Slack message in 1 thread as read",
    ]) {
      expect(screen.getByRole("checkbox", { name })).toBeInTheDocument()
    }
  })

  it("marks everything listed, each through what was shown", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(markResourceRead).toHaveBeenCalledTimes(4))
    expect(markResourceRead).toHaveBeenCalledWith({ type: "pr", id: "o/r#1", through_ts: "2099-01-02T00:00:00Z" })
    expect(markResourceRead).toHaveBeenCalledWith({ type: "pr", id: "o/r#2", through_ts: "2099-01-03T00:00:00Z" })
    expect(markResourceRead).toHaveBeenCalledWith({ type: "jira", id: "J-1", through_ts: "2099-01-05T00:00:00Z" })
    expect(markResourceRead).toHaveBeenCalledWith({ type: "jira", id: "J-2", through_ts: "2099-01-06T00:00:00Z" })
    expect(markThreadRead).toHaveBeenCalledTimes(2)
    expect(markThreadRead).toHaveBeenCalledWith("C1", "1.2", "1790000000.000100")
    expect(markThreadRead).toHaveBeenCalledWith("C2", "3.4", "1790000009.000900")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("opens on R, and Enter in the preview marks them read", async () => {
    wrap(everything())
    fireEvent.keyDown(document, { key: "r" })
    await screen.findByRole("dialog")
    fireEvent.keyDown(document, { key: "r" })
    expect(markResourceRead).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: "Enter" })
    await waitFor(() => expect(markResourceRead).toHaveBeenCalledTimes(4))
    expect(markThreadRead).toHaveBeenCalledTimes(2)
  })

  it("leaves Enter to Cancel when Cancel has focus", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    const cancel = screen.getByRole("button", { name: "Cancel" })
    cancel.focus()
    fireEvent.keyDown(cancel, { key: "Enter" })
    expect(markResourceRead).not.toHaveBeenCalled()
  })

  it("skips a type that is unchecked", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    await user.click(screen.getByRole("checkbox", { name: /GitHub/ }))
    await user.click(screen.getByRole("checkbox", { name: /Slack/ }))
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(markResourceRead).toHaveBeenCalledTimes(2))
    expect(markResourceRead.mock.calls.every(([a]) => (a as { type: string }).type === "jira")).toBe(true)
    expect(markThreadRead).not.toHaveBeenCalled()
  })

  it("disables Mark read with nothing checked", async () => {
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", 2)])
    await open(user)
    await user.click(screen.getByRole("checkbox", { name: /Jira/ }))
    await user.click(screen.getByRole("checkbox", { name: /Slack/ }))
    expect(screen.getByRole("button", { name: "Mark read" })).toBeDisabled()
  })

  it("starts fully checked again on the next open", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    await user.click(screen.getByRole("checkbox", { name: /Slack/ }))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await open(user)
    expect(screen.getByRole("checkbox", { name: /Slack/ })).toBeChecked()
  })

  it("sends nothing on cancel", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(markResourceRead).not.toHaveBeenCalled()
    expect(markThreadRead).not.toHaveBeenCalled()
  })

  it("skips resources missing the timestamp to mark through", async () => {
    // Never guess at a cursor: an older server's resource without
    // unread_through_ts, or a thread never polled to an updated_ts, is left
    // out of both the counts and the writes.
    const user = userEvent.setup()
    const unpolled = { ...slack("C9:9.9", 4), updated_ts: undefined } as ResourceDTO
    wrap([jira("J-1", 2, "2099-01-05T00:00:00Z"), jira("J-2", 9), unpolled])
    await open(user)
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
    expect(screen.getByRole("checkbox", { name: "Mark 2 Jira events in 1 issue as read" })).toBeInTheDocument()
  })

  it("keeps the modal open and shows the error when a write fails", async () => {
    markResourceRead.mockImplementation(() => Promise.reject(new Error("boom")))
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
    await open(user)
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  describe("undo", () => {
    it("offers to undo, restoring each cursor the mark moved", async () => {
      const user = userEvent.setup()
      wrap([
        pr("o/r#1", 2, "2099-01-02T00:00:00Z"),
        { ...slack("C1:1.2", 1), last_read: "1789999999.000100" } as ResourceDTO,
      ])
      await open(user)
      await user.click(screen.getByRole("button", { name: "Mark read" }))
      expect(await screen.findByText("Marked 2 GitHub events, 1 Slack message read")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Undo" }))
      await waitFor(() => expect(restoreResourceRead).toHaveBeenCalledTimes(1))
      expect(restoreResourceRead).toHaveBeenCalledWith({
        type: "pr", id: "o/r#1", previous_ts: "2099-01-01T00:00:00Z", last_read_ts: "2099-01-02T00:00:00Z",
      })
      expect(restoreThreadRead).toHaveBeenCalledWith("C1", "1.2", "1789999999.000100", "1790000000.000100")
      await waitFor(() => expect(screen.queryByText(/Marked 2 GitHub/)).not.toBeInTheDocument())
    })

    it("offers nothing when no cursor moved", async () => {
      markResourceRead.mockResolvedValue({ previous_ts: "2099-01-09T00:00:00Z", last_read_ts: "2099-01-09T00:00:00Z" })
      const user = userEvent.setup()
      wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
      await open(user)
      await user.click(screen.getByRole("button", { name: "Mark read" }))
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument()
    })

    it("says so when the undo is refused", async () => {
      restoreResourceRead.mockRejectedValue(new Error("read state changed since it was marked read"))
      const user = userEvent.setup()
      wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
      await open(user)
      await user.click(screen.getByRole("button", { name: "Mark read" }))
      await user.click(await screen.findByRole("button", { name: "Undo" }))
      expect(await screen.findByText("Couldn't undo: read state changed since it was marked read")).toBeInTheDocument()
    })
  })

  describe("preview column", () => {
    const three = () => [pr("o/r#1", 1, "2099-01-02T00:00:00Z"), jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", 1)]

    it("lists the unread events of every checked type", async () => {
      const user = userEvent.setup()
      wrap(three())
      await open(user)
      expect(screen.getByText("The following activity will be marked as read")).toBeInTheDocument()
      for (const t of ["a PR comment", "a Jira comment", "a Slack reply"]) {
        expect(await screen.findByText(t)).toBeInTheDocument()
      }
      // Unread only, never archived, narrowed to the checked types.
      const [archived, , , types, unreadOnly] = globalTimeline.mock.calls.at(-1)!
      expect(archived).toBe(false)
      expect(unreadOnly).toBe(true)
      expect([...(types as string[])].sort()).toEqual(["jira", "pr", "slack"])
    })

    it("drops an unchecked type's events", async () => {
      const user = userEvent.setup()
      wrap(three())
      await open(user)
      await screen.findByText("a Jira comment")
      await user.click(screen.getByRole("checkbox", { name: /Jira/ }))
      await waitFor(() => expect(screen.queryByText("a Jira comment")).not.toBeInTheDocument())
      expect(screen.getByText("a PR comment")).toBeInTheDocument()
    })

    it("lists nothing, and asks for nothing, with every type unchecked", async () => {
      // An empty resource_types means "every type" to the server.
      const user = userEvent.setup()
      wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
      await open(user)
      await screen.findByText("a Jira comment")
      const calls = globalTimeline.mock.calls.length
      await user.click(screen.getByRole("checkbox", { name: /Jira/ }))
      await waitFor(() => expect(screen.queryByText("a Jira comment")).not.toBeInTheDocument())
      expect(globalTimeline).toHaveBeenCalledTimes(calls)
    })

    it("reads a worktree's own feed when given one", async () => {
      const user = userEvent.setup()
      wrap(three(), { worktree: "/wt/a" })
      await open(user)
      await screen.findByText("a PR comment")
      expect(globalTimeline).not.toHaveBeenCalled()
      const [path, , resource, , , unreadOnly] = worktreeTimeline.mock.calls.at(-1)!
      expect(path).toBe("/wt/a")
      expect(resource).toBeUndefined()
      expect(unreadOnly).toBe(true)
    })

    it("opens an event's details over the modal, leaving it open, when an event is clicked", async () => {
      const user = userEvent.setup()
      wrap(three())
      await open(user)
      await user.hover(await screen.findByText("a PR comment"))
      expect(await screen.findByText("View event details")).toBeInTheDocument()
      await user.click(screen.getByText("a PR comment"))
      await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(2))
      expect(screen.getByRole("dialog", { name: "Mark all read" })).toBeInTheDocument()
      expect(markResourceRead).not.toHaveBeenCalled()
    })
  })

  describe("tasks", () => {
    const fixIt = { id: 7, title: "Fix it", count: 2, newest_ts: "2099-02-01T00:00:00Z" }
    const other = { id: 8, title: "Other", count: 1, newest_ts: "2099-02-02T00:00:00Z" }

    it("asks for the unread tasks of its scope", async () => {
      wrap([], { worktree: "/wt/a" }, { taskScope: { kind: "worktree", path: "/wt/a" } })
      await waitFor(() => expect(taskUnread).toHaveBeenCalledWith({ kind: "worktree", path: "/wt/a" }))
    })

    it("shows the button when only tasks are unread", async () => {
      taskUnread.mockResolvedValue([fixIt])
      wrap([])
      expect(await screen.findByRole("button", { name: /mark all read/i })).toBeInTheDocument()
    })

    it("lists each unread task as a checked row, and marks each through its newest unread event", async () => {
      taskUnread.mockResolvedValue([fixIt, other])
      const user = userEvent.setup()
      wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
      await screen.findByRole("button", { name: /mark all read/i })
      await open(user)
      expect(await screen.findByRole("checkbox", { name: "T7 Fix it" })).toBeChecked()
      expect(screen.getByRole("checkbox", { name: "T8 Other" })).toBeChecked()
      await user.click(screen.getByRole("button", { name: "Mark read" }))
      await waitFor(() => expect(taskRead).toHaveBeenCalledTimes(2))
      expect(taskRead).toHaveBeenCalledWith({ id: 7, through_ts: "2099-02-01T00:00:00Z" })
      expect(taskRead).toHaveBeenCalledWith({ id: 8, through_ts: "2099-02-02T00:00:00Z" })
      expect(markResourceRead).toHaveBeenCalledTimes(1)
      expect(await screen.findByText("Marked 1 Jira event, 3 task events read")).toBeInTheDocument()
    })

    it("skips an unchecked task", async () => {
      taskUnread.mockResolvedValue([fixIt, other])
      const user = userEvent.setup()
      wrap([])
      await screen.findByRole("button", { name: /mark all read/i })
      await open(user)
      await user.click(screen.getByRole("checkbox", { name: "T7 Fix it" }))
      await user.click(screen.getByRole("button", { name: "Mark read" }))
      await waitFor(() => expect(taskRead).toHaveBeenCalledTimes(1))
      expect(taskRead).toHaveBeenCalledWith({ id: 8, through_ts: "2099-02-02T00:00:00Z" })
    })

    it("disables Mark read with every resource type and task unchecked", async () => {
      taskUnread.mockResolvedValue([fixIt])
      const user = userEvent.setup()
      wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
      await screen.findByRole("button", { name: /mark all read/i })
      await open(user)
      await user.click(screen.getByRole("checkbox", { name: /Jira/ }))
      expect(screen.getByRole("button", { name: "Mark read" })).toBeEnabled()
      await user.click(screen.getByRole("checkbox", { name: "T7 Fix it" }))
      expect(screen.getByRole("button", { name: "Mark read" })).toBeDisabled()
    })

    it("previews the checked tasks' events, and drops an unchecked task's", async () => {
      taskUnread.mockResolvedValue([fixIt, other])
      const taskEv = (id: string, task: string, title: string) =>
        ({ ...ev(id, "task", title), source: "tasks", resource_id: task }) as TimelineEvent
      globalTimeline.mockImplementation((_a, _l, _b, types?: string[]) =>
        Promise.resolve({
          events: [taskEv("task:1", "7", "agent did seven"), taskEv("task:2", "8", "agent did eight")]
            .filter(() => types?.includes("task")),
          next_cursor: "",
        }))
      const user = userEvent.setup()
      wrap([])
      await screen.findByRole("button", { name: /mark all read/i })
      await open(user)
      expect(await screen.findByText("agent did seven")).toBeInTheDocument()
      expect(screen.getByText("agent did eight")).toBeInTheDocument()
      await user.click(screen.getByRole("checkbox", { name: "T7 Fix it" }))
      await waitFor(() => expect(screen.queryByText("agent did seven")).not.toBeInTheDocument())
      expect(screen.getByText("agent did eight")).toBeInTheDocument()
    })

    it("undo restores the task cursors too, and one refused still restores the rest", async () => {
      taskUnread.mockResolvedValue([fixIt, other])
      taskReadRestore.mockImplementation((a: { id: number }) =>
        a.id === 7 ? Promise.reject(new Error("read state changed since it was marked read")) : Promise.resolve(null))
      const user = userEvent.setup()
      wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
      await screen.findByRole("button", { name: /mark all read/i })
      await open(user)
      await user.click(screen.getByRole("button", { name: "Mark read" }))
      await user.click(await screen.findByRole("button", { name: "Undo" }))
      expect(await screen.findByText("Couldn't undo: T7: read state changed since it was marked read")).toBeInTheDocument()
      expect(taskReadRestore).toHaveBeenCalledWith({
        id: 7, previous_ts: "2099-01-01T00:00:00Z", last_read_ts: "2099-02-01T00:00:00Z",
      })
      expect(taskReadRestore).toHaveBeenCalledWith({
        id: 8, previous_ts: "2099-01-01T00:00:00Z", last_read_ts: "2099-02-02T00:00:00Z",
      })
      expect(restoreResourceRead).toHaveBeenCalledTimes(1)
    })

    it("reports every undo failure, naming each item", async () => {
      taskUnread.mockResolvedValue([fixIt])
      taskReadRestore.mockRejectedValue(new Error("task cursor moved"))
      restoreResourceRead.mockRejectedValue(new Error("resource cursor moved"))
      const user = userEvent.setup()
      wrap([pr("o/r#4521", 1, "2099-01-05T00:00:00Z")])
      await screen.findByRole("button", { name: /mark all read/i })
      await open(user)
      await user.click(screen.getByRole("button", { name: "Mark read" }))
      await user.click(await screen.findByRole("button", { name: "Undo" }))
      expect(await screen.findByText("Couldn't undo: #4521: resource cursor moved; T7: task cursor moved")).toBeInTheDocument()
    })

    it("offers undo for the writes that landed when a task mark fails", async () => {
      taskUnread.mockResolvedValue([fixIt])
      taskRead.mockRejectedValue(new Error("task gone"))
      const user = userEvent.setup()
      wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
      await screen.findByRole("button", { name: /mark all read/i })
      await open(user)
      await user.click(screen.getByRole("button", { name: "Mark read" }))
      expect(await screen.findByText(/task gone/)).toBeInTheDocument()
      await user.click(await screen.findByRole("button", { name: "Undo" }))
      await waitFor(() => expect(restoreResourceRead).toHaveBeenCalledTimes(1))
      expect(taskReadRestore).not.toHaveBeenCalled()
    })

    describe("single form", () => {
      it("marks the tasks linking the resource", async () => {
        taskUnread.mockResolvedValue([fixIt])
        const user = userEvent.setup()
        const r = { ...jira("J-1", 3, "2099-01-05T00:00:00Z"), task_unread_count: 2 } as ResourceDTO
        wrap([r], { worktree: "/wt/a" }, { single: true, taskScope: { kind: "resource", type: "jira", id: "J-1" } })
        await waitFor(() => expect(taskUnread).toHaveBeenCalledWith({ kind: "resource", type: "jira", id: "J-1" }))
        await open(user)
        await user.click(screen.getByRole("button", { name: "Mark read" }))
        await waitFor(() => expect(taskRead).toHaveBeenCalledWith({ id: 7, through_ts: "2099-02-01T00:00:00Z" }))
        expect(markResourceRead).toHaveBeenCalledWith({ type: "jira", id: "J-1", through_ts: "2099-01-05T00:00:00Z" })
        expect(await screen.findByText("Marked 1 Jira event, 2 task events read")).toBeInTheDocument()
      })

      it("clears a Slack thread whose only unread is task activity, without marking the thread", async () => {
        taskUnread.mockResolvedValue([fixIt])
        const user = userEvent.setup()
        const thread = { ...slack("C1:1.2", 0), unread_count: 2, task_unread_count: 2 } as ResourceDTO
        wrap([thread], { worktree: "/wt/a" }, { single: true, taskScope: { kind: "resource", type: "slack", id: "C1:1.2" } })
        await screen.findByRole("button", { name: /mark all read/i })
        await open(user)
        await user.click(screen.getByRole("button", { name: "Mark read" }))
        await waitFor(() => expect(taskRead).toHaveBeenCalledWith({ id: 7, through_ts: "2099-02-01T00:00:00Z" }))
        expect(markThreadRead).not.toHaveBeenCalled()
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
      })
    })

    it("clears a Slack thread whose only unread is task activity from the worktree's form too", async () => {
      taskUnread.mockResolvedValue([fixIt])
      const user = userEvent.setup()
      const thread = { ...slack("C1:1.2", 0), unread_count: 2, task_unread_count: 2 } as ResourceDTO
      wrap([thread], { worktree: "/wt/a" }, { taskScope: { kind: "worktree", path: "/wt/a" } })
      await screen.findByRole("button", { name: /mark all read/i })
      await open(user)
      expect(screen.queryByRole("checkbox", { name: /Slack/ })).not.toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Mark read" }))
      await waitFor(() => expect(taskRead).toHaveBeenCalledTimes(1))
      expect(markThreadRead).not.toHaveBeenCalled()
    })
  })
})
