import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
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
  it("takes focus when it opens", () => {
    setup()
    expect(screen.getByRole("textbox")).toHaveFocus()
  })

  it("takes focus once it lands in the page, when it mounts detached (a diff annotation slot)", async () => {
    const slot = document.createElement("div")
    render(
      <MantineProvider>
        <CommentEditor initial="" submitLabel="Save" onSubmit={vi.fn()} onCancel={vi.fn()} />
      </MantineProvider>,
      { container: slot },
    )
    const box = slot.querySelector("textarea")!
    expect(box).not.toHaveFocus()
    document.body.appendChild(slot)
    await waitFor(() => expect(box).toHaveFocus())
    slot.remove()
  })

  it("Cmd+Enter submits", async () => {
    const { onSubmit } = setup()
    await userEvent.type(screen.getByRole("textbox"), "hello{Meta>}{Enter}{/Meta}")
    expect(onSubmit).toHaveBeenCalledWith("hello")
  })

  it("opens with the initial text and reports each change", async () => {
    const onChange = vi.fn()
    render(
      <MantineProvider>
        <CommentEditor initial="ab" onChange={onChange} submitLabel="Save" onSubmit={vi.fn()} onCancel={vi.fn()} />
      </MantineProvider>,
    )
    expect(screen.getByRole("textbox")).toHaveValue("ab")
    await userEvent.type(screen.getByRole("textbox"), "c")
    expect(onChange).toHaveBeenLastCalledWith("abc")
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

  describe("actions", () => {
    function setupActions() {
      const first = vi.fn()
      const second = vi.fn()
      const third = vi.fn()
      render(
        <MantineProvider>
          <CommentEditor
            initial=""
            onCancel={vi.fn()}
            actions={[
              { key: "a", label: "Alpha", tooltip: "Alpha tip", disabledReason: "alpha is off", onSubmit: first },
              { key: "b", label: "Beta", tooltip: "Beta tip", onSubmit: second, variant: "light" },
              { key: "c", label: "Gamma", tooltip: "Gamma tip", onSubmit: third, variant: "light" },
            ]}
          />
        </MantineProvider>,
      )
      return { first, second, third }
    }

    it("renders a button per action", () => {
      setupActions()
      for (const name of ["Alpha", "Beta", "Gamma"]) expect(screen.getByRole("button", { name })).toBeInTheDocument()
    })

    it("a disabled action keeps its button, and its tooltip gives the reason", async () => {
      const { first } = setupActions()
      await userEvent.type(screen.getByRole("textbox"), "x")
      const alpha = screen.getByRole("button", { name: "Alpha" })
      expect(alpha).toHaveAttribute("aria-disabled", "true")
      await userEvent.hover(alpha)
      expect(await screen.findByText("alpha is off")).toBeInTheDocument()
      expect(screen.queryByText("Alpha tip")).toBeNull()
      await userEvent.click(alpha)
      expect(first).not.toHaveBeenCalled()
    })

    it("an enabled action's tooltip is its own, and a click runs it", async () => {
      const { second } = setupActions()
      await userEvent.type(screen.getByRole("textbox"), "x")
      const gamma = screen.getByRole("button", { name: "Gamma" })
      await userEvent.hover(gamma)
      expect(await screen.findByText("Gamma tip")).toBeInTheDocument()
      await userEvent.click(screen.getByRole("button", { name: "Beta" }))
      expect(second).toHaveBeenCalledWith("x")
    })

    it("Ctrl+Enter runs the first enabled action", async () => {
      const { first, second, third } = setupActions()
      await userEvent.type(screen.getByRole("textbox"), "hi{Control>}{Enter}{/Control}")
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledWith("hi")
      expect(third).not.toHaveBeenCalled()
    })
  })
})
