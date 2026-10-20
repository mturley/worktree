import { afterEach, describe, it, expect, vi } from "vitest"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { useUnreadOnlyHotkey } from "./useUnreadOnlyHotkey"

function Probe({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  useUnreadOnlyHotkey(value, onChange)
  return <input aria-label="field" />
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

describe("useUnreadOnlyHotkey", () => {
  it("flips the value on U, either case", () => {
    const onChange = vi.fn()
    const view = render(<Probe value={false} onChange={onChange} />)
    fireEvent.keyDown(document, { key: "u" })
    expect(onChange).toHaveBeenLastCalledWith(true)
    view.rerender(<Probe value onChange={onChange} />)
    fireEvent.keyDown(document, { key: "U" })
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it("ignores U with a modifier, while typing, or under an open modal", () => {
    const onChange = vi.fn()
    const view = render(<Probe value={false} onChange={onChange} />)
    fireEvent.keyDown(document, { key: "u", metaKey: true })
    fireEvent.keyDown(document, { key: "u", ctrlKey: true })

    const field = view.getByLabelText("field")
    field.focus()
    fireEvent.keyDown(field, { key: "u" })
    field.blur()

    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    document.body.appendChild(dialog)
    fireEvent.keyDown(document, { key: "u" })

    expect(onChange).not.toHaveBeenCalled()
  })
})
