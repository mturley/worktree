import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { Task } from "../../api/types"
import { TaskRow } from "./TaskRow"
import { TaskPriorityMenu } from "./TaskPriorityMenu"

afterEach(cleanup)
const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

function task(over: Partial<Task> = {}): Task {
  return {
    id: 1, ref: "T1", title: "t", description: "", state: "not_started",
    priority: "none", starred: false, rank: "a", created_at: "", updated_at: "",
    archived: false, links: [], implicit_worktrees: [], subtasks_total: 0, subtasks_done: 0,
    blocked: false, blocker_count: 0, open_blockers: [], ...over,
  }
}

describe("TaskPriorityMenu", () => {
  it("lists every priority with its mark and ticks the current one", async () => {
    wrap(<TaskPriorityMenu priority="none" title="t" onPick={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: "Priority of “t”: None" }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("High"),
      expect.stringContaining("Medium"),
      expect.stringContaining("Low"),
      expect.stringContaining("None"),
    ])
    expect(items[0]).toHaveTextContent("!!!")
    expect(items[1]).toHaveTextContent("!!")
    expect(items[2]).toHaveTextContent("!")
    expect(items[3]).toHaveAttribute("aria-current", "true")
    expect(items[0]).not.toHaveAttribute("aria-current")
  })

  it("shows a faint placeholder for no priority", () => {
    wrap(<TaskPriorityMenu priority="none" title="t" onPick={() => {}} />)
    const target = screen.getByRole("button", { name: "Priority of “t”: None" })
    expect(target).toHaveTextContent("!")
    expect(target).toHaveClass("task-priority-none")
  })

  it("a pick calls onPick and does not open the row", async () => {
    const onOpen = vi.fn()
    const onPriority = vi.fn()
    wrap(<TaskRow task={task()} onState={() => {}} onToggleStar={() => {}} onPriority={onPriority} onOpen={onOpen} />)
    await userEvent.click(screen.getByRole("button", { name: "Priority of “t”: None" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: /High/ }))
    expect(onPriority).toHaveBeenCalledWith("high")
    expect(onOpen).not.toHaveBeenCalled()
  })
})
