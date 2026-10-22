import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { api } from "../../../api/client"
import type { TaskDetail } from "../../../api/types"
import { SubtasksSection } from "./SubtasksSection"
import { detail, renderDetail, stubRowLayout } from "./detailsTestUtils"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: {
    taskDetail: vi.fn(),
    addSubtask: vi.fn(),
    editSubtask: vi.fn(),
    checkSubtask: vi.fn(),
    removeSubtask: vi.fn(),
    orderSubtasks: vi.fn(),
  },
}))

const base = detail({
  subtasks: [
    { id: 10, text: "first", checked: true },
    { id: 11, text: "second", checked: false },
    { id: 12, text: "third", checked: false },
  ],
  subtasks_total: 3,
  subtasks_done: 1,
})

/** Every write answers with `next`, which later refetches return too. */
function serve(next: TaskDetail) {
  vi.mocked(api.taskDetail).mockResolvedValue(next)
  return next
}

beforeEach(() => {
  serve(base)
  for (const fn of [api.addSubtask, api.editSubtask, api.checkSubtask, api.removeSubtask, api.orderSubtasks]) {
    vi.mocked(fn).mockResolvedValue(base)
  }
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const show = (t = base) => renderDetail(t, (d) => <SubtasksSection task={d} />)

describe("SubtasksSection", () => {
  it("shows done/total", () => {
    show()
    expect(screen.getByText("1/3")).toBeInTheDocument()
  })

  it("Enter adds a subtask and keeps focus in the input", async () => {
    const next = serve(detail({ ...base, subtasks: [...base.subtasks, { id: 13, text: "fourth", checked: false }] }))
    vi.mocked(api.addSubtask).mockResolvedValue(next)
    const user = userEvent.setup()
    show()
    const input = screen.getByRole("textbox", { name: "New subtask" })
    await user.type(input, "fourth{Enter}")
    expect(api.addSubtask).toHaveBeenCalledWith(1, "fourth")
    expect(await screen.findByRole("button", { name: "Edit subtask: fourth" })).toBeInTheDocument()
    expect(input).toHaveValue("")
    expect(input).toHaveFocus()
  })

  it("checking writes at once", async () => {
    vi.mocked(api.checkSubtask).mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    show()
    const box = screen.getByRole("checkbox", { name: "Subtask done: second" })
    await user.click(box)
    expect(api.checkSubtask).toHaveBeenCalledWith(11, true)
    // Shown before the server replies.
    expect(box).toBeChecked()
  })

  it("click the text to edit in place: Enter saves, Escape cancels", async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole("button", { name: "Edit subtask: second" }))
    const box = screen.getByRole("textbox", { name: "Subtask text" })
    expect(box).toHaveFocus()
    await user.clear(box)
    await user.type(box, "2nd{Enter}")
    expect(api.editSubtask).toHaveBeenCalledWith(11, "2nd")

    await user.click(screen.getByRole("button", { name: "Edit subtask: third" }))
    await user.type(screen.getByRole("textbox", { name: "Subtask text" }), "xx{Escape}")
    expect(screen.queryByRole("textbox", { name: "Subtask text" })).toBeNull()
    expect(api.editSubtask).toHaveBeenCalledTimes(1)
  })

  it("removes without asking", async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole("button", { name: "Remove subtask: third" }))
    expect(api.removeSubtask).toHaveBeenCalledWith(12)
  })

  describe("drag", () => {
    beforeEach(() => {
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        stubRowLayout("[data-subtask-sortable]", "[data-subtask-list]"),
      )
    })
    afterEach(() => vi.mocked(Element.prototype.getBoundingClientRect).mockRestore())

    it("keyboard reorder sends the full new order", async () => {
      show()
      const grip = screen.getByRole("button", { name: "Drag to reorder first" })
      act(() => grip.focus())
      fireEvent.keyDown(grip, { code: "Space", key: " " })
      // Picked up once dnd-kit has measured the rows, which takes a render.
      await waitFor(() => expect(grip).toHaveAttribute("aria-pressed", "true"))
      fireEvent.keyDown(grip, { code: "ArrowDown", key: "ArrowDown" })
      fireEvent.keyDown(grip, { code: "Space", key: " " })
      await waitFor(() => expect(api.orderSubtasks).toHaveBeenCalled())
      expect(api.orderSubtasks).toHaveBeenCalledWith(1, [11, 10, 12])
    })

    it("a failed reorder puts the old order back and says why", async () => {
      vi.mocked(api.orderSubtasks).mockRejectedValue(new Error("nope"))
      show()
      const grip = screen.getByRole("button", { name: "Drag to reorder first" })
      act(() => grip.focus())
      fireEvent.keyDown(grip, { code: "Space", key: " " })
      await waitFor(() => expect(grip).toHaveAttribute("aria-pressed", "true"))
      fireEvent.keyDown(grip, { code: "ArrowDown", key: "ArrowDown" })
      fireEvent.keyDown(grip, { code: "Space", key: " " })
      expect(await screen.findByText(/nope/)).toBeInTheDocument()
      const order = screen.getAllByRole("button", { name: /^Edit subtask: / }).map((b) => b.textContent)
      expect(order).toEqual(["first", "second", "third"])
    })
  })
})
