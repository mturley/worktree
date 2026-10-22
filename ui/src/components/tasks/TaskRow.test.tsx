import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { Task } from "../../api/types"
import { TaskRow } from "./TaskRow"
import { TaskStateCheckbox } from "./TaskStateCheckbox"
import { TaskCountBadge } from "./TaskCountBadge"

afterEach(cleanup)
const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1, ref: "T1", title: "Write the thing", description: "", state: "in_progress",
    priority: "high", starred: false, rank: "a", created_at: "", updated_at: "",
    archived: false, links: [], implicit_worktrees: [], subtasks_total: 0, subtasks_done: 0,
    ...over,
  }
}

describe("TaskStateCheckbox", () => {
  it("opens the state menu and changes nothing until a pick", async () => {
    const onPick = vi.fn()
    wrap(<TaskStateCheckbox state="in_progress" title="Write the thing" onPick={onPick} />)
    await userEvent.click(screen.getByRole("button", { name: "State of “Write the thing”: In progress" }))
    // The current state is marked; the others are not.
    expect(await screen.findByRole("menuitem", { name: /In progress/ })).toHaveAttribute("aria-current", "true")
    expect(screen.getByRole("menuitem", { name: "Done" })).not.toHaveAttribute("aria-current")
    expect(onPick).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("menuitem", { name: "Not started" }))
    expect(onPick).toHaveBeenCalledWith("not_started")
  })
})

describe("TaskRow", () => {
  it("renders title, priority, due, subtask and link chips", () => {
    const due = new Date()
    due.setDate(due.getDate() - 2)
    const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`
    wrap(<TaskRow
      task={task({
        due: iso, subtasks_total: 5, subtasks_done: 2,
        links: [{ kind: "resource", resource_type: "github_pr", resource_id: "o/r#5", focus: true, archived: false }],
      })}
      onState={() => {}} onToggleStar={() => {}}
    />)
    expect(screen.getByText("Write the thing")).toBeInTheDocument()
    expect(screen.getByText("!!!")).toBeInTheDocument()
    expect(screen.getByText("Overdue 2 days")).toBeInTheDocument()
    expect(screen.getByText("2/5")).toBeInTheDocument()
    expect(screen.getByTestId("task-link-chip")).toBeInTheDocument()
  })

  it("omits the link chip on its own resource's list", () => {
    wrap(<TaskRow
      task={task({ links: [{ kind: "resource", resource_type: "github_pr", resource_id: "o/r#5", focus: true, archived: false }] })}
      ownResource={{ type: "github_pr", id: "o/r#5" }}
      onState={() => {}} onToggleStar={() => {}}
    />)
    expect(screen.queryByTestId("task-link-chip")).toBeNull()
  })

  it("star button names its task, reports pressed, and calls onToggleStar", async () => {
    const onToggleStar = vi.fn()
    wrap(<TaskRow task={task()} onState={() => {}} onToggleStar={onToggleStar} />)
    const star = screen.getByRole("button", { name: "Star “Write the thing”" })
    expect(star).toHaveAttribute("aria-pressed", "false")
    await userEvent.click(star)
    expect(onToggleStar).toHaveBeenCalled()
  })

  it("a starred row's star offers Unstar, pressed", () => {
    wrap(<TaskRow task={task({ starred: true })} onState={() => {}} onToggleStar={() => {}} />)
    expect(screen.getByRole("button", { name: "Unstar “Write the thing”" })).toHaveAttribute("aria-pressed", "true")
  })

  it("the state checkbox names its task", () => {
    wrap(<TaskRow task={task()} onState={() => {}} onToggleStar={() => {}} />)
    expect(screen.getByRole("button", { name: "State of “Write the thing”: In progress" })).toBeInTheDocument()
  })
})

describe("TaskRow opens the modal", () => {
  const row = () => document.querySelector<HTMLElement>("[data-task-row]")!

  it("a click on the row opens it, once", async () => {
    const onOpen = vi.fn()
    wrap(<TaskRow task={task()} onState={() => {}} onToggleStar={() => {}} onOpen={onOpen} />)
    // The priority mark: part of the row, not a control.
    await userEvent.click(screen.getByText("!!!"))
    expect(onOpen).toHaveBeenCalledTimes(1)
    await userEvent.click(row())
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it("the title is a button: a click, Enter or Space on it opens, once each", async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    wrap(<TaskRow task={task()} onState={() => {}} onToggleStar={() => {}} onOpen={onOpen} />)
    const title = screen.getByRole("button", { name: "Write the thing" })
    await user.click(title)
    expect(onOpen).toHaveBeenCalledTimes(1)
    act(() => title.focus())
    await user.keyboard("{Enter}")
    expect(onOpen).toHaveBeenCalledTimes(2)
    await user.keyboard(" ")
    expect(onOpen).toHaveBeenCalledTimes(3)
  })

  it("the checkbox, a state picked from its portalled menu, and the star do not open it", async () => {
    const onOpen = vi.fn()
    const onState = vi.fn()
    const onToggleStar = vi.fn()
    wrap(<TaskRow task={task()} onState={onState} onToggleStar={onToggleStar} onOpen={onOpen} />)
    await userEvent.click(screen.getByRole("button", { name: "State of “Write the thing”: In progress" }))
    const done = await screen.findByRole("menuitem", { name: "Done" })
    // Rendered in a portal, outside the row's DOM; React still bubbles to it.
    expect(row().contains(done)).toBe(false)
    await userEvent.click(done)
    expect(onState).toHaveBeenCalledWith("done")
    await userEvent.click(screen.getByRole("button", { name: "Star “Write the thing”" }))
    expect(onToggleStar).toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("the grip and the link chip do not open it", async () => {
    const onOpen = vi.fn()
    const onGrip = vi.fn()
    const onGripDown = vi.fn()
    wrap(<TaskRow
      task={task({ links: [{ kind: "resource", resource_type: "github_pr", resource_id: "o/r#5", focus: true, archived: false }] })}
      dragHandle={<button type="button" aria-label="grip" onClick={onGrip} onPointerDown={onGripDown}>::</button>}
      onState={() => {}} onToggleStar={() => {}} onOpen={onOpen}
    />)
    await userEvent.click(screen.getByRole("button", { name: "grip" }))
    // The grip's own handlers (where dnd-kit's listeners live) still run.
    expect(onGrip).toHaveBeenCalled()
    expect(onGripDown).toHaveBeenCalled()
    await userEvent.click(screen.getByTestId("task-link-chip"))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("without onOpen the title is plain text (the drag overlay's copy)", () => {
    wrap(<TaskRow task={task()} onState={() => {}} onToggleStar={() => {}} />)
    expect(screen.queryByRole("button", { name: "Write the thing" })).toBeNull()
    expect(screen.getByText("Write the thing")).toBeInTheDocument()
  })
})

describe("TaskCountBadge", () => {
  it("renders nothing for zero", () => {
    const { container } = wrap(<TaskCountBadge count={0} />)
    expect(container.querySelector(".task-count-badge")).toBeNull()
  })
  it("renders the count", () => {
    wrap(<TaskCountBadge count={3} />)
    expect(screen.getByText("3")).toBeInTheDocument()
  })
})
