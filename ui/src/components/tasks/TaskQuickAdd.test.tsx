import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
    // A fixed label; aria-pressed carries the state.
    expect(screen.getByRole("button", { name: "Star new task" })).toHaveAttribute("aria-pressed", "true")
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

  it("Add & open keeps focus on press, creates the task, then opens the new id", async () => {
    const onAdd = vi.fn().mockResolvedValue({ id: 42 })
    const onOpen = vi.fn()
    render(<MantineProvider><TaskQuickAdd onAdd={onAdd} onOpen={onOpen} /></MantineProvider>)
    const input = screen.getByRole("textbox", { name: "New task" })
    act(() => input.focus())
    fireEvent.change(input, { target: { value: "y" } })
    const addOpen = screen.getByRole("button", { name: "Add & open" })
    expect(fireEvent.mouseDown(addOpen)).toBe(false)
    webkitClick(addOpen, input)
    expect(onAdd).toHaveBeenCalledWith({ title: "y", priority: "none", starred: false })
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(42))
    expect(input).toHaveValue("")
  })

  it("Enter adds and stays: it never opens", async () => {
    const onAdd = vi.fn().mockResolvedValue({ id: 42 })
    const onOpen = vi.fn()
    render(<MantineProvider><TaskQuickAdd onAdd={onAdd} onOpen={onOpen} /></MantineProvider>)
    const input = screen.getByRole("textbox", { name: "New task" })
    act(() => input.focus())
    fireEvent.change(input, { target: { value: "z" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(input).toHaveValue(""))
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
    expect(input).toHaveFocus()
  })

  it("a failed Add & open keeps the text and opens nothing", async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error("nope"))
    const onOpen = vi.fn()
    render(<MantineProvider><TaskQuickAdd onAdd={onAdd} onOpen={onOpen} /></MantineProvider>)
    const input = screen.getByRole("textbox", { name: "New task" })
    act(() => input.focus())
    fireEvent.change(input, { target: { value: "w" } })
    webkitClick(screen.getByRole("button", { name: "Add & open" }), input)
    await waitFor(() => expect(onAdd).toHaveBeenCalled())
    await waitFor(() => expect(input).not.toHaveAttribute("readonly"))
    expect(input).toHaveValue("w")
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("without onOpen there is no Add & open", () => {
    render(<MantineProvider><TaskQuickAdd onAdd={vi.fn()} /></MantineProvider>)
    const input = screen.getByRole("textbox", { name: "New task" })
    act(() => input.focus())
    fireEvent.change(input, { target: { value: "v" } })
    expect(screen.queryByRole("button", { name: "Add & open" })).toBeNull()
  })
})
