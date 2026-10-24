import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { CommentEditor } from "./CommentEditor"

afterEach(cleanup)

function setup(initial = "") {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  render(
    <MantineProvider>
      <CommentEditor initial={initial} submitLabel="Save" onSubmit={onSubmit} onCancel={onCancel} />
    </MantineProvider>,
  )
  return { onSubmit, onCancel }
}

describe("CommentEditor", () => {
  it("Cmd+Enter submits", async () => {
    const { onSubmit } = setup()
    await userEvent.type(screen.getByRole("textbox"), "hello{Meta>}{Enter}{/Meta}")
    expect(onSubmit).toHaveBeenCalledWith("hello")
  })

  it("Ctrl+Enter submits", async () => {
    const { onSubmit } = setup()
    await userEvent.type(screen.getByRole("textbox"), "hello{Control>}{Enter}{/Control}")
    expect(onSubmit).toHaveBeenCalledWith("hello")
  })

  it("empty text does not submit", async () => {
    const { onSubmit } = setup()
    await userEvent.type(screen.getByRole("textbox"), "  {Control>}{Enter}{/Control}")
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("Escape cancels and is not propagated", async () => {
    const { onCancel } = setup("x")
    const seen = vi.fn()
    document.addEventListener("keydown", seen)
    await userEvent.type(screen.getByRole("textbox"), "{Escape}")
    document.removeEventListener("keydown", seen)
    expect(onCancel).toHaveBeenCalled()
    expect(seen.mock.calls.filter(([e]) => (e as KeyboardEvent).key === "Escape")).toHaveLength(0)
  })
})
