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
    wrap(<TaskStateCheckbox state="in_progress" onPick={onPick} />)
    await userEvent.click(screen.getByRole("button", { name: /task state/i }))
    expect(await screen.findByRole("menuitem", { name: "In progress" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Done" })).toBeInTheDocument()
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

  it("star button calls onToggleStar", async () => {
    const onToggleStar = vi.fn()
    wrap(<TaskRow task={task()} onState={() => {}} onToggleStar={onToggleStar} />)
    await userEvent.click(screen.getByRole("button", { name: "Star task" }))
    expect(onToggleStar).toHaveBeenCalled()
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
