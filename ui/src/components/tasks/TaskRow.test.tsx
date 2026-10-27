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
    archived: false, links: [], implicit_worktrees: [], subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [],
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
      onState={() => {}} onPriority={() => {}} onToggleStar={() => {}}
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
      onState={() => {}} onPriority={() => {}} onToggleStar={() => {}}
    />)
    expect(screen.queryByTestId("task-link-chip")).toBeNull()
  })

  it("star button names its task, reports pressed, and calls onToggleStar", async () => {
    const onToggleStar = vi.fn()
    wrap(<TaskRow task={task()} onState={() => {}} onPriority={() => {}} onToggleStar={onToggleStar} />)
    const star = screen.getByRole("button", { name: "Star “Write the thing”" })
    expect(star).toHaveAttribute("aria-pressed", "false")
    await userEvent.click(star)
    expect(onToggleStar).toHaveBeenCalled()
  })

  it("a starred row's star offers Unstar, pressed", () => {
    wrap(<TaskRow task={task({ starred: true })} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} />)
    expect(screen.getByRole("button", { name: "Unstar “Write the thing”" })).toHaveAttribute("aria-pressed", "true")
  })

  it("the state checkbox names its task", () => {
    wrap(<TaskRow task={task()} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} />)
    expect(screen.getByRole("button", { name: "State of “Write the thing”: In progress" })).toBeInTheDocument()
  })
})

describe("TaskRow opens the modal", () => {
  const row = () => document.querySelector<HTMLElement>("[data-task-row]")!

  it("a click on the row opens it, once", async () => {
    const onOpen = vi.fn()
    wrap(<TaskRow task={task()} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} onOpen={onOpen} />)
    await userEvent.click(row())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it("the title is a button: a click, Enter or Space on it opens, once each", async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    wrap(<TaskRow task={task()} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} onOpen={onOpen} />)
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
    wrap(<TaskRow task={task()} onState={onState} onPriority={() => {}} onToggleStar={onToggleStar} onOpen={onOpen} />)
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
      onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} onOpen={onOpen}
    />)
    await userEvent.click(screen.getByRole("button", { name: "grip" }))
    // The grip's own handlers (where dnd-kit's listeners live) still run.
    expect(onGrip).toHaveBeenCalled()
    expect(onGripDown).toHaveBeenCalled()
    await userEvent.click(screen.getByTestId("task-link-chip"))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("a worktree chip opens that worktree's page, not the task", async () => {
    const onOpen = vi.fn()
    window.history.pushState({}, "", "/")
    wrap(<TaskRow
      task={task({ links: [{ kind: "worktree", worktree: "/w/repo/fix", focus: true, archived: false }] })}
      onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} onOpen={onOpen}
    />)
    await userEvent.click(screen.getByRole("button", { name: "Open worktree ⎇ fix" }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/w/repo/fix")}`)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("leaves out the chip on its own worktree's list", () => {
    wrap(<TaskRow
      task={task({ links: [{ kind: "worktree", worktree: "/w/repo/fix", focus: true, archived: false }] })}
      ownWorktree="/w/repo/fix"
      onState={() => {}} onPriority={() => {}} onToggleStar={() => {}}
    />)
    expect(screen.queryByTestId("task-link-chip")).toBeNull()
  })

  it("without onOpen the title is plain text (the drag overlay's copy)", () => {
    wrap(<TaskRow task={task()} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} />)
    expect(screen.queryByRole("button", { name: "Write the thing" })).toBeNull()
    expect(screen.getByText("Write the thing")).toBeInTheDocument()
  })

  it("shows the blue unread dot while the task has unread events", () => {
    wrap(<TaskRow task={task({ unread_count: 2 })} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} />)
    expect(screen.getByLabelText("unread task activity")).toBeInTheDocument()
  })

  it("shows no unread dot when the task is read, or the count is absent", () => {
    const { unmount } = wrap(<TaskRow task={task({ unread_count: 0 })} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} />)
    expect(screen.queryByLabelText("unread task activity")).toBeNull()
    unmount()
    wrap(<TaskRow task={task()} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} />)
    expect(screen.queryByLabelText("unread task activity")).toBeNull()
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

describe("TaskRow blocked chip", () => {
  it("shows a red blocked chip whose tooltip lists the unresolved blockers", async () => {
    const user = userEvent.setup()
    wrap(<TaskRow
      task={task({ blocked: true, blocker_count: 2, blocker_labels: ["T4 Ship the API", "#4498"] })}
      onState={() => {}} onPriority={() => {}} onToggleStar={() => {}}
    />)
    const chip = screen.getByTestId("task-blocked-chip")
    expect(chip).toHaveTextContent("⛔ blocked")
    expect(chip.closest(".mantine-Badge-root")).toHaveStyle({ "--badge-color": "var(--mantine-color-red-light-color)" })
    await user.hover(chip)
    const tip = await screen.findByRole("tooltip")
    expect(tip).toHaveTextContent("T4 Ship the API")
    expect(tip).toHaveTextContent("#4498")
  })

  it("shows no chip for an unblocked task", () => {
    wrap(<TaskRow task={task()} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} />)
    expect(screen.queryByTestId("task-blocked-chip")).toBeNull()
  })

  it("shows no chip for a done task, even one still flagged blocked", () => {
    wrap(<TaskRow
      task={task({ state: "done", blocked: true, blocker_count: 1, blocker_labels: ["#4498"] })}
      onState={() => {}} onPriority={() => {}} onToggleStar={() => {}}
    />)
    expect(screen.queryByTestId("task-blocked-chip")).toBeNull()
  })
})
