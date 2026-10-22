import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
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
