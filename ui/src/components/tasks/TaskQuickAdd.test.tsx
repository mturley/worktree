import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { TaskQuickAdd } from "./TaskQuickAdd"

afterEach(cleanup)

/**
 * A click as WebKit (Safari, the cmux browser pane) does it: buttons take no
 * focus, so unless mousedown's default is prevented the input blurs to the
 * body before the click lands.
 */
function webkitClick(el: HTMLElement, input: HTMLElement) {
  const notPrevented = fireEvent.mouseDown(el)
  if (notPrevented) act(() => input.blur())
  fireEvent.mouseUp(el)
  fireEvent.click(el)
}

describe("TaskQuickAdd under WebKit focus rules", () => {
  it("clicking the star while the input is focused and empty keeps the row open and toggles the star", () => {
    render(<MantineProvider><TaskQuickAdd onAdd={vi.fn().mockResolvedValue(undefined)} /></MantineProvider>)
    const input = screen.getByRole("textbox", { name: "New task" })
    act(() => input.focus())
    webkitClick(screen.getByRole("button", { name: "Star new task" }), input)
    expect(screen.getByRole("button", { name: "Unstar new task" })).toHaveAttribute("aria-pressed", "true")
    expect(input).toHaveFocus()
  })

  it("pressing Add keeps focus in the input, and the click adds the task", () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(<MantineProvider><TaskQuickAdd onAdd={onAdd} /></MantineProvider>)
    const input = screen.getByRole("textbox", { name: "New task" })
    act(() => input.focus())
    fireEvent.change(input, { target: { value: "x" } })
    const add = screen.getByRole("button", { name: "Add" })
    // Default prevented: the press never takes focus from the input.
    expect(fireEvent.mouseDown(add)).toBe(false)
    webkitClick(add, input)
    expect(input).toHaveFocus()
    expect(onAdd).toHaveBeenCalledWith({ title: "x", priority: "none", starred: false })
  })
})
