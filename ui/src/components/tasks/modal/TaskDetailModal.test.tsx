import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { Notifications, notifications } from "@mantine/notifications"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api, HttpError } from "../../../api/client"
import type { TaskDetail } from "../../../api/types"
import { taskDetailKey } from "../../../hooks/useTaskDetail"
import { TaskDetailModal } from "./TaskDetailModal"
import { TaskModalProvider, useTaskModal } from "./TaskModalProvider"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: {
    taskDetail: vi.fn(),
    taskActivity: vi.fn(),
    updateTask: vi.fn(),
    setTaskState: vi.fn(),
    deleteTask: vi.fn(),
    undoTask: vi.fn(),
  },
}))

const detail = (id: number, extra: Partial<TaskDetail> = {}): TaskDetail => ({
  id, ref: `T${id}`, title: `task ${id}`, description: "", state: "not_started", priority: "none", starred: false,
  rank: "r", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-21T00:00:00Z", archived: false,
  links: [], implicit_worktrees: [], subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [],
  detail_links: [], implicit: [], subtasks: [], event_links: [], blockers: [], blocks: [], ...extra,
})

function Opener() {
  const { open, openId } = useTaskModal()
  return (
    <>
      <span data-testid="open-id">{openId ?? "none"}</span>
      <button onClick={() => open(9)}>open nine</button>
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
    expect(screen.getByLabelText("Priority")).toBeInTheDocument()
    expect(screen.getByText("Created")).toBeInTheDocument()
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
    await user.selectOptions(screen.getByLabelText("Priority"), "high")
    expect(api.updateTask).toHaveBeenCalledWith(5, { priority: "high" })
    expect(screen.getByLabelText("Priority")).toHaveValue("high")
  })

  it("rolls the optimistic change back when the save fails", async () => {
    vi.mocked(api.updateTask).mockRejectedValue(new Error("nope"))
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await user.selectOptions(screen.getByLabelText("Priority"), "low")
    await waitFor(() => expect(screen.getByLabelText("Priority")).toHaveValue("none"))
  })

  it("saves state from the sidebar, and shows it before the server replies", async () => {
    vi.mocked(api.setTaskState).mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    wrap()
    await titleButton()
    await user.selectOptions(screen.getByLabelText("State"), "in_progress")
    expect(api.setTaskState).toHaveBeenCalledWith(5, "in_progress")
    expect(screen.getByLabelText("State")).toHaveValue("in_progress")
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
      await user.selectOptions(screen.getByLabelText("State"), "in_progress")
      expect(await screen.findByText("Marked “task 5” in progress")).toBeInTheDocument()
    })

    it("offers no undo when the change changed nothing", async () => {
      vi.mocked(api.setTaskState).mockResolvedValue(detail(5))
      const user = userEvent.setup()
      wrap()
      await titleButton()
      await user.selectOptions(screen.getByLabelText("State"), "in_progress")
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
      await user.selectOptions(screen.getByLabelText("State"), "not_started")
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

  it("shows Task not found for an unknown id, with a close button", async () => {
    vi.mocked(api.taskDetail).mockRejectedValue(new HttpError("task not found", 404))
    const user = userEvent.setup()
    wrap()
    expect(await screen.findByText("Task not found")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(param()).toBeNull())
  })
})
