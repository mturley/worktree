import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { Notifications, notifications } from "@mantine/notifications"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api, HttpError } from "../../../api/client"
import type { ResourceDTO, TaskDetail, TimelineEvent } from "../../../api/types"
import { taskDetailKey } from "../../../hooks/useTaskDetail"
import { TaskDetailModal } from "./TaskDetailModal"
import { TaskModalProvider, useTaskModal } from "./TaskModalProvider"

/** Picks `option` from the sidebar's `label` Select. */
async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole("textbox", { name: label }))
  await user.click(await screen.findByRole("option", { name: option }))
}

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: {
    taskDetail: vi.fn(),
    taskActivity: vi.fn(),
    updateTask: vi.fn(),
    setTaskState: vi.fn(),
    deleteTask: vi.fn(),
    undoTask: vi.fn(),
    taskUnread: vi.fn(),
    markResourceRead: vi.fn(),
  },
}))

const detail = (id: number, extra: Partial<TaskDetail> = {}): TaskDetail => ({
  id, ref: `T${id}`, title: `task ${id}`, description: "", state: "not_started", priority: "none", starred: false,
  rank: "r", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-21T00:00:00Z", archived: false,
  links: [], implicit_worktrees: [], subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, open_blockers: [],
  detail_links: [], implicit: [], subtasks: [], event_links: [], blockers: [], blocks: [], linked_resources: [], ...extra,
})

/** A work log of task `id`, as a feed row hands it to open(). */
const workLog = (id: number): TimelineEvent => ({
  id: "task:42", ts: "2026-10-20T00:00:00Z", external_ts: "", source: "tasks", type: "task_work_logged",
  type_label: "work logged", title: "Worked on the thing", body: "a note", author: "me", resource_type: "task",
  resource_id: String(id), resource_url: "", resource_title: `task ${id}`, worktrees: [],
})

function Opener() {
  const { open, openId } = useTaskModal()
  return (
    <>
      <span data-testid="open-id">{openId ?? "none"}</span>
      <button onClick={() => open(9)}>open nine</button>
      <button onClick={() => open(7, { event: workLog(7) })}>open seven with event</button>
      <button onClick={() => open(99, { event: workLog(99) })}>open ninety-nine with event</button>
    </>
  )
}

let qc: QueryClient
function wrap() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <Notifications />
      <QueryClientProvider client={qc}>
        <TaskModalProvider>
          <Opener />
          <TaskDetailModal />
        </TaskModalProvider>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

const param = () => new URLSearchParams(window.location.search).get("task")

beforeEach(() => {
  window.history.replaceState({}, "", "/worktree/wt?resource=pr:x&task=5")
  vi.mocked(api.taskDetail).mockImplementation(async (id: number) => detail(id))
  vi.mocked(api.updateTask).mockResolvedValue(detail(5))
  vi.mocked(api.setTaskState).mockResolvedValue(detail(5))
  vi.mocked(api.deleteTask).mockResolvedValue({ undo_event_id: 61 })
  vi.mocked(api.undoTask).mockResolvedValue(undefined)
  vi.mocked(api.taskUnread).mockResolvedValue([])
})
afterEach(() => {
  cleanup()
  notifications.clean()
  vi.clearAllMocks()
})

const titleButton = () => screen.findByRole("button", { name: /^Edit title/ })

describe("TaskDetailModal", () => {
  it("opens for ?task=5, and closing removes only the task param", async () => {
    const user = userEvent.setup()
    wrap()
    expect(await titleButton()).toHaveTextContent("task 5")
    expect(api.taskDetail).toHaveBeenCalledWith(5)
    await user.click(screen.getByRole("button", { name: "Close task" }))
    await waitFor(() => expect(param()).toBeNull())
    expect(new URLSearchParams(window.location.search).get("resource")).toBe("pr:x")
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Edit title/ })).not.toBeInTheDocument())
  })

  it("open(id) sets the param and keeps the others", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=pr:x")
    const user = userEvent.setup()
    wrap()
    expect(screen.getByTestId("open-id")).toHaveTextContent("none")
    await user.click(screen.getByRole("button", { name: "open nine" }))
    expect(param()).toBe("9")
    expect(new URLSearchParams(window.location.search).get("resource")).toBe("pr:x")
    expect(await titleButton()).toHaveTextContent("task 9")
  })

  it("renders the Details and Activity tabs and the sidebar", async () => {
    wrap()
    await titleButton()
    expect(screen.getByRole("tab", { name: "Details" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Activity" })).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Priority" })).toBeInTheDocument()
    expect(screen.getByText("Created")).toBeInTheDocument()
  })

  it("badges the Activity tab with the combined unread count", async () => {
    vi.mocked(api.taskDetail).mockResolvedValue(detail(9, { combined_unread_count: 3 }))
    wrap()
    await titleButton()
    expect(within(screen.getByRole("tab", { name: /Activity/ })).getByText("3 unreads")).toBeInTheDocument()
  })

  it("puts no badge on Activity at 0 or when the count is absent", async () => {
    vi.mocked(api.taskDetail).mockResolvedValue(detail(9, { combined_unread_count: 0 }))
    wrap()
    await titleButton()
    expect(within(screen.getByRole("tab", { name: "Activity" })).queryByText(/unread/)).toBeNull()
  })

  it("saves the title on Enter and shows it at once", async () => {
    let resolve!: (d: TaskDetail) => void
    vi.mocked(api.updateTask).mockReturnValue(new Promise((r) => { resolve = r }))
    const user = userEvent.setup()
    wrap()
    await user.click(await titleButton())
    const input = screen.getByRole("textbox", { name: "Title" })
    await user.clear(input)
    await user.type(input, "Renamed{Enter}")
    expect(api.updateTask).toHaveBeenCalledTimes(1)
    expect(api.updateTask).toHaveBeenCalledWith(5, { title: "Renamed" })
    // Optimistic: shown before the server replies.
    expect(await titleButton()).toHaveTextContent("Renamed")
    await act(async () => resolve(detail(5, { title: "Renamed" })))
  })

  it("saves the title on blur", async () => {
    const user = userEvent.setup()
    wrap()
    await user.click(await titleButton())
    const input = screen.getByRole("textbox", { name: "Title" })
    await user.type(input, "!")
    fireEvent.blur(input)
    expect(api.updateTask).toHaveBeenCalledWith(5, { title: "task 5!" })
  })

  it("reverts the title on Esc without closing the modal", async () => {
    const user = userEvent.setup()
    wrap()
    await user.click(await titleButton())
    const input = screen.getByRole("textbox", { name: "Title" })
    await user.type(input, " changed{Escape}")
    expect(api.updateTask).not.toHaveBeenCalled()
    expect(await titleButton()).toHaveTextContent(/^task 5$/)
    expect(param()).toBe("5")
  })

  it("never overwrites the draft with a refetch while the title is focused", async () => {
    const user = userEvent.setup()
    wrap()
    await user.click(await titleButton())
    const input = screen.getByRole("textbox", { name: "Title" })
    await user.clear(input)
    await user.type(input, "My draft")
    vi.mocked(api.taskDetail).mockResolvedValue(detail(5, { title: "Server changed it" }))
    await act(async () => { await qc.refetchQueries({ queryKey: taskDetailKey(5) }) })
    expect(qc.getQueryData<TaskDetail>(taskDetailKey(5))?.title).toBe("Server changed it")
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("My draft")
  })

  it("saves priority on change, and shows it before the server replies", async () => {
    vi.mocked(api.updateTask).mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await pick(user, "Priority", "High")
    expect(api.updateTask).toHaveBeenCalledWith(5, { priority: "high" })
    expect(screen.getByRole("textbox", { name: "Priority" })).toHaveValue("High")
  })

  it("rolls the optimistic change back when the save fails", async () => {
    vi.mocked(api.updateTask).mockRejectedValue(new Error("nope"))
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await pick(user, "Priority", "Low")
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Priority" })).toHaveValue("None"))
  })

  it("saves state from the sidebar, and shows it before the server replies", async () => {
    vi.mocked(api.setTaskState).mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await pick(user, "State", "In progress")
    expect(api.setTaskState).toHaveBeenCalledWith(5, "in_progress")
    expect(screen.getByRole("textbox", { name: "State" })).toHaveValue("In progress")
  })

  it("saves starred from the sidebar", async () => {
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await user.click(screen.getByRole("checkbox", { name: "Starred" }))
    expect(api.updateTask).toHaveBeenCalledWith(5, { starred: true })
  })

  it("saves the due date on change, and clearing it sends an empty due", async () => {
    vi.mocked(api.taskDetail).mockImplementation(async (id: number) => detail(id, { due: "2026-10-30" }))
    vi.mocked(api.updateTask).mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    wrap()
    await titleButton()
    const due = screen.getByLabelText("Due date")
    expect(due).toHaveValue("2026-10-30")
    fireEvent.change(due, { target: { value: "2026-11-01" } })
    expect(api.updateTask).toHaveBeenCalledWith(5, { due: "2026-11-01" })
    await user.click(screen.getByRole("button", { name: "Clear due date" }))
    expect(api.updateTask).toHaveBeenLastCalledWith(5, { due: "" })
    expect(screen.getByLabelText("Due date")).toHaveValue("")
  })

  it("asks before deleting; No keeps the task", async () => {
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await user.click(screen.getByRole("button", { name: "Delete task" }))
    expect(screen.getByText("Delete?")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "No" }))
    expect(api.deleteTask).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Delete task" })).toBeInTheDocument()
  })

  it("deletes on Yes, closing the modal and dropping the task's cached detail", async () => {
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await user.click(screen.getByRole("button", { name: "Delete task" }))
    await user.click(screen.getByRole("button", { name: "Yes" }))
    expect(api.deleteTask).toHaveBeenCalledWith(5)
    expect(param()).toBeNull()
    expect(qc.getQueryData(taskDetailKey(5))).toBeUndefined()
    // No refetch of the deleted task after the delete's invalidation.
    await waitFor(() => expect(api.deleteTask).toHaveBeenCalledTimes(1))
    expect(api.taskDetail).toHaveBeenCalledTimes(1)
  })

  it("reopens the task and says why when the delete fails", async () => {
    vi.mocked(api.deleteTask).mockRejectedValue(new Error("disk full"))
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await user.click(screen.getByRole("button", { name: "Delete task" }))
    await user.click(screen.getByRole("button", { name: "Yes" }))
    expect(await screen.findByText("Couldn't delete: disk full")).toBeInTheDocument()
    expect(param()).toBe("5")
    expect(await titleButton()).toHaveTextContent("task 5")
  })

  it("reopens on the page showing at failure time, not the one from before the delete", async () => {
    let reject!: (e: Error) => void
    vi.mocked(api.deleteTask).mockReturnValue(new Promise((_, r) => { reject = r }))
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await user.click(screen.getByRole("button", { name: "Delete task" }))
    await user.click(screen.getByRole("button", { name: "Yes" }))
    // The user moves on while the delete is in flight.
    act(() => {
      window.history.pushState({}, "", "/worktree/other?resource=jira:J-1")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await act(async () => reject(new Error("nope")))
    await waitFor(() => expect(param()).toBe("5"))
    expect(window.location.pathname).toBe("/worktree/other")
    expect(new URLSearchParams(window.location.search).get("resource")).toBe("jira:J-1")
  })

  describe("undo", () => {
    it("a state change from the header offers an undo, which takes back its event", async () => {
      vi.mocked(api.setTaskState).mockResolvedValue(detail(5, { state: "done", undo_event_id: 71 }))
      const user = userEvent.setup()
      wrap()
      await titleButton()
      await user.click(screen.getByRole("button", { name: /^State of “task 5”/ }))
      await user.click(await screen.findByRole("menuitem", { name: /Done/ }))
      expect(await screen.findByText("Marked “task 5” done")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Undo" }))
      expect(api.undoTask).toHaveBeenCalledWith(71)
    })

    it("a state change from the sidebar offers an undo", async () => {
      vi.mocked(api.setTaskState).mockResolvedValue(detail(5, { state: "in_progress", undo_event_id: 72 }))
      const user = userEvent.setup()
      wrap()
      await titleButton()
      await pick(user, "State", "In progress")
      expect(await screen.findByText("Marked “task 5” in progress")).toBeInTheDocument()
    })

    it("offers no undo when the change changed nothing", async () => {
      vi.mocked(api.setTaskState).mockResolvedValue(detail(5))
      const user = userEvent.setup()
      wrap()
      await titleButton()
      await pick(user, "State", "In progress")
      await waitFor(() => expect(api.setTaskState).toHaveBeenCalled())
      await new Promise((r) => setTimeout(r, 20))
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument()
    })

    it("a refused undo (409) says why", async () => {
      vi.mocked(api.setTaskState).mockResolvedValue(detail(5, { state: "not_started", undo_event_id: 73 }))
      vi.mocked(api.undoTask).mockRejectedValue(new HttpError("The task changed since; nothing was undone.", 409))
      vi.mocked(api.taskDetail).mockImplementation(async (id: number) => detail(id, { state: "done" }))
      const user = userEvent.setup()
      wrap()
      await titleButton()
      await pick(user, "State", "Not started")
      await user.click(await screen.findByRole("button", { name: "Undo" }))
      expect(await screen.findByText("Couldn't undo: The task changed since; nothing was undone.")).toBeInTheDocument()
    })

    it("a delete offers an undo, which brings the task back and reopens its modal", async () => {
      const user = userEvent.setup()
      wrap()
      await titleButton()
      await user.click(screen.getByRole("button", { name: "Delete task" }))
      await user.click(screen.getByRole("button", { name: "Yes" }))
      expect(param()).toBeNull()
      expect(await screen.findByText("Deleted “task 5”")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Undo" }))
      expect(api.undoTask).toHaveBeenCalledWith(61)
      await waitFor(() => expect(param()).toBe("5"))
      expect(await titleButton()).toHaveTextContent("task 5")
    })

    it("a refused delete undo leaves the modal closed", async () => {
      vi.mocked(api.undoTask).mockRejectedValue(new HttpError("gone", 404))
      const user = userEvent.setup()
      wrap()
      await titleButton()
      await user.click(screen.getByRole("button", { name: "Delete task" }))
      await user.click(screen.getByRole("button", { name: "Yes" }))
      await user.click(await screen.findByRole("button", { name: "Undo" }))
      expect(await screen.findByText("Couldn't undo: gone")).toBeInTheDocument()
      expect(param()).toBeNull()
    })
  })

  it("closing a modal that open() pushed goes back, so Back doesn't reopen it", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=pr:x")
    const back = vi.spyOn(window.history, "back")
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("button", { name: "open nine" }))
    await titleButton()
    await user.click(screen.getByRole("button", { name: "Close task" }))
    expect(back).toHaveBeenCalledTimes(1)
    // Closed at once, before the popstate lands.
    expect(screen.getByTestId("open-id")).toHaveTextContent("none")
    await waitFor(() => expect(window.location.search).toBe("?resource=pr:x"))
    expect(screen.getByTestId("open-id")).toHaveTextContent("none")
  })

  it("closing a deep-linked modal replaces the URL rather than going back", async () => {
    const back = vi.spyOn(window.history, "back")
    const before = window.history.length
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "Close task" }))
    expect(back).not.toHaveBeenCalled()
    expect(param()).toBeNull()
    expect(window.location.pathname).toBe("/worktree/wt")
    expect(window.history.length).toBe(before)
  })

  it("Esc in the header's state menu closes the menu, not the modal", async () => {
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await user.click(screen.getByRole("button", { name: /^State of “task 5”/ }))
    expect(await screen.findByRole("menuitem", { name: /In progress/ })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: /In progress/ })).not.toBeInTheDocument())
    expect(param()).toBe("5")
    expect(screen.getByRole("button", { name: /^Edit title/ })).toBeInTheDocument()
  })

  it("is labelled by the title in its header", async () => {
    const user = userEvent.setup()
    wrap()
    const dialog = await screen.findByRole("dialog", { name: "task 5" })
    const label = document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")
    expect(label).toHaveTextContent("task 5")
    expect(screen.getByRole("button", { name: /^Edit title/ })).toContainElement(label)
    // Still named while the title is being edited.
    await user.click(await titleButton())
    expect(screen.getByRole("dialog", { name: "task 5" })).toBeInTheDocument()
  })

  describe("with unsaved description edits", () => {
    const overlay = () => document.querySelector<HTMLElement>(".mantine-Modal-overlay")!
    const editDescription = async (user: ReturnType<typeof userEvent.setup>) => {
      await titleButton()
      await user.click(screen.getByRole("button", { name: "Edit description" }))
      await user.type(screen.getByRole("textbox", { name: "Description" }), "draft")
    }
    afterEach(() => sessionStorage.clear())

    it("an outside click closes a clean modal", async () => {
      wrap()
      await titleButton()
      fireEvent.click(overlay())
      await waitFor(() => expect(param()).toBeNull())
    })

    it("an outside click does not close it", async () => {
      const user = userEvent.setup()
      wrap()
      await editDescription(user)
      fireEvent.click(overlay())
      expect(param()).toBe("5")
      expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("draft")
    })

    it("the close button asks first, and No keeps the draft", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
      const user = userEvent.setup()
      wrap()
      await editDescription(user)
      await user.click(screen.getByRole("button", { name: "Close task" }))
      expect(confirm).toHaveBeenCalledWith("Discard unsaved description?")
      expect(param()).toBe("5")
      expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("draft")
    })

    it("discarding closes and forgets the draft", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true)
      const user = userEvent.setup()
      wrap()
      await editDescription(user)
      await user.click(screen.getByRole("button", { name: "Close task" }))
      await waitFor(() => expect(param()).toBeNull())
      expect(sessionStorage.getItem("task-description-draft:5")).toBeNull()
    })

    it("a clean modal closes without asking", async () => {
      const confirm = vi.spyOn(window, "confirm")
      const user = userEvent.setup()
      wrap()
      await titleButton()
      await user.click(screen.getByRole("button", { name: "Edit description" }))
      await user.click(screen.getByRole("button", { name: "Close task" }))
      expect(confirm).not.toHaveBeenCalled()
      await waitFor(() => expect(param()).toBeNull())
    })

    it("Back closes it without asking, and reopening restores the draft", async () => {
      const confirm = vi.spyOn(window, "confirm")
      const user = userEvent.setup()
      wrap()
      await editDescription(user)
      act(() => {
        window.history.pushState({}, "", "/worktree/wt?resource=pr:x")
        window.dispatchEvent(new PopStateEvent("popstate"))
      })
      await waitFor(() => expect(screen.queryByRole("textbox", { name: "Description" })).not.toBeInTheDocument())
      expect(confirm).not.toHaveBeenCalled()
      act(() => {
        window.history.pushState({}, "", "/worktree/wt?resource=pr:x&task=5")
        window.dispatchEvent(new PopStateEvent("popstate"))
      })
      expect(await screen.findByRole("textbox", { name: "Description" })).toHaveValue("draft")
      expect(screen.getByText("Unsaved draft restored")).toBeInTheDocument()
    })
  })

  describe("opened with an event", () => {
    beforeEach(() => {
      window.history.replaceState({}, "", "/")
      vi.mocked(api.taskActivity).mockResolvedValue({ events: [], next_cursor: "" })
    })
    const dialogs = () => screen.queryAllByRole("dialog")
    const detailsDialog = () => dialogs().find((d) => within(d).queryByText("Worked on the thing"))
    const openSeven = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("button", { name: "open seven with event" }))
      await waitFor(() => expect(detailsDialog()).toBeDefined())
      return detailsDialog()!
    }

    it("shows the Activity tab with the event's details stacked on top, kept out of the URL", async () => {
      const user = userEvent.setup()
      wrap()
      const details = await openSeven(user)
      expect(param()).toBe("7")
      expect(window.location.search).toBe("?task=7")
      expect(await titleButton()).toHaveTextContent("task 7")
      expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
      expect(within(details).queryByRole("button", { name: "Make task" })).toBeNull()
      // Closing the details leaves the task modal open on Activity.
      await user.click(details.querySelector<HTMLElement>(".mantine-Modal-close")!)
      await waitFor(() => expect(detailsDialog()).toBeUndefined())
      expect(screen.getByTestId("open-id")).toHaveTextContent("7")
      expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true")
      // Closing again closes the task modal.
      await user.click(screen.getByRole("button", { name: "Close task" }))
      await waitFor(() => expect(param()).toBeNull())
    })

    it("renders the details above the task modal", async () => {
      const user = userEvent.setup()
      wrap()
      await openSeven(user)
      await titleButton()
      const z = (el: Element) => Number(getComputedStyle(el.closest("[style*='--mb-z-index']")!).getPropertyValue("--mb-z-index"))
      const task = screen.getByRole("button", { name: /^Edit title/ })
      expect(z(detailsDialog()!)).toBeGreaterThan(z(task))
    })

    it("Esc closes only the details; a second Esc closes the task modal", async () => {
      const user = userEvent.setup()
      wrap()
      const details = await openSeven(user)
      await titleButton()
      // Real focus inside the top modal: its focus trap puts it there.
      await waitFor(() => expect(details.contains(document.activeElement)).toBe(true))
      fireEvent.keyDown(document.activeElement!, { key: "Escape" })
      await waitFor(() => expect(detailsDialog()).toBeUndefined())
      // openId drops at once on close, ahead of history.back()'s popstate.
      expect(screen.getByTestId("open-id")).toHaveTextContent("7")
      expect(param()).toBe("7")
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
      expect(screen.getByTestId("open-id")).toHaveTextContent("none")
      await waitFor(() => expect(param()).toBeNull())
    })

    it("a task that is gone shows the event's details on their own, without Edit", async () => {
      vi.mocked(api.taskDetail).mockRejectedValue(new HttpError("task not found", 404))
      const user = userEvent.setup()
      wrap()
      await user.click(screen.getByRole("button", { name: "open ninety-nine with event" }))
      await waitFor(() => expect(detailsDialog()).toBeDefined())
      expect(screen.queryByText("Task not found")).toBeNull()
      expect(within(detailsDialog()!).queryByRole("button", { name: "Edit" })).toBeNull()
      await user.click(detailsDialog()!.querySelector<HTMLElement>(".mantine-Modal-close")!)
      await waitFor(() => expect(param()).toBeNull())
    })
  })

  describe("Mark all read", () => {
    const prEvent = {
      id: "ev:1", ts: "2099-03-01T00:00:00Z", external_ts: "", source: "github", type: "pr_comment",
      type_label: "comment", title: "an unread PR comment", body: "", author: "", resource_type: "pr",
      resource_id: "o/r#1", resource_url: "", resource_title: "", worktrees: [], unread: true,
    } as unknown as TimelineEvent
    const dialogs = () => screen.queryAllByRole("dialog")
    const confirmDialog = () => dialogs().find((d) => d.getAttribute("aria-labelledby") &&
      within(d).queryByRole("button", { name: "Mark read" }))
    const esc = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    beforeEach(() => {
      vi.mocked(api.taskDetail).mockImplementation(async (id: number) => detail(id, {
        combined_unread_count: 1,
        linked_resources: [{ type: "pr", id: "o/r#1", url: "u", primary: true, unread_count: 1,
          unread_through_ts: "2099-03-01T00:00:00Z" } as ResourceDTO],
      }))
      vi.mocked(api.taskActivity).mockResolvedValue({ events: [prEvent], next_cursor: "" })
    })

    it("opens over the task modal, and Esc closes one layer at a time: details, the confirm, the task", async () => {
      const user = userEvent.setup()
      wrap()
      await titleButton()
      await user.click(await screen.findByRole("button", { name: /Mark all read/ }))
      await waitFor(() => expect(confirmDialog()).toBeDefined())
      const confirm = confirmDialog()!
      await user.click(await within(confirm).findByText("an unread PR comment"))
      await waitFor(() => expect(dialogs()).toHaveLength(3))
      const taskDialog = screen.getByRole("button", { name: /^Edit title/ }).closest("[role=dialog]")
      const details = dialogs().find((d) => d !== confirm && d !== taskDialog)!
      expect(details).toBeDefined()
      // Real focus inside the top modal: its focus trap puts it there.
      await waitFor(() => expect(details.contains(document.activeElement)).toBe(true))

      esc()
      await waitFor(() => expect(dialogs()).toHaveLength(2))
      expect(confirmDialog()).toBeDefined()
      expect(param()).toBe("5")

      await waitFor(() => expect(confirmDialog()!.contains(document.activeElement)).toBe(true))
      esc()
      await waitFor(() => expect(confirmDialog()).toBeUndefined())
      expect(screen.getByTestId("open-id")).toHaveTextContent("5")
      expect(param()).toBe("5")

      esc()
      await waitFor(() => expect(param()).toBeNull())
    })

    it("R does nothing while event details are stacked over the task modal", async () => {
      window.history.replaceState({}, "", "/")
      const user = userEvent.setup()
      wrap()
      await user.click(screen.getByRole("button", { name: "open seven with event" }))
      await screen.findByRole("button", { name: /Mark all read/ })
      await waitFor(() => expect(dialogs()).toHaveLength(2))
      ;(document.activeElement as HTMLElement | null)?.blur()
      fireEvent.keyDown(document.body, { key: "r" })
      // Long enough for an opening confirm to show (it does below).
      await expect(waitFor(() => expect(confirmDialog()).toBeDefined(), { timeout: 300 })).rejects.toThrow()
      expect(dialogs()).toHaveLength(2)
      // With the details closed, the task modal is on top and R opens the confirm.
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
      await waitFor(() => expect(dialogs()).toHaveLength(1))
      ;(document.activeElement as HTMLElement | null)?.blur()
      fireEvent.keyDown(document.body, { key: "r" })
      await waitFor(() => expect(confirmDialog()).toBeDefined())
    })

    it("Enter in event details stacked over the confirm does not mark", async () => {
      const user = userEvent.setup()
      wrap()
      await titleButton()
      await user.click(await screen.findByRole("button", { name: /Mark all read/ }))
      await waitFor(() => expect(confirmDialog()).toBeDefined())
      await user.click(await within(confirmDialog()!).findByText("an unread PR comment"))
      await waitFor(() => expect(dialogs()).toHaveLength(3))
      // Focus off any control, so Enter is the hotkey's to take.
      ;(document.activeElement as HTMLElement | null)?.blur()
      fireEvent.keyDown(document.body, { key: "Enter" })
      await expect(waitFor(() => expect(api.markResourceRead).toHaveBeenCalled(), { timeout: 300 })).rejects.toThrow()
      expect(dialogs()).toHaveLength(3)
    })
  })

  it("shows Task not found for an unknown id, with a close button", async () => {
    vi.mocked(api.taskDetail).mockRejectedValue(new HttpError("task not found", 404))
    const user = userEvent.setup()
    wrap()
    expect(await screen.findByText("Task not found")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(param()).toBeNull())
  })
})
