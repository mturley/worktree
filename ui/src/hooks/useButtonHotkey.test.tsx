import { afterEach, describe, it, expect, vi } from "vitest"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { useButtonHotkey } from "./useButtonHotkey"

function Btn({ onPress, enabled = true, hidden = false }: { onPress: () => void; enabled?: boolean; hidden?: boolean }) {
  const ref = useButtonHotkey("r", onPress, enabled)
  return <div hidden={hidden}><button ref={ref}>Mark read</button></div>
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

describe("useButtonHotkey", () => {
  it("presses on R, either case, while enabled", () => {
    const onPress = vi.fn()
    const view = render(<Btn onPress={onPress} />)
    fireEvent.keyDown(document, { key: "r" })
    fireEvent.keyDown(document, { key: "R" })
    expect(onPress).toHaveBeenCalledTimes(2)
    view.rerender(<Btn onPress={onPress} enabled={false} />)
    fireEvent.keyDown(document, { key: "r" })
    expect(onPress).toHaveBeenCalledTimes(2)
  })

  it("ignores Cmd+R, typing, and a button that is not on screen", () => {
    const onPress = vi.fn()
    const view = render(<><Btn onPress={onPress} hidden /><input aria-label="field" /></>)
    fireEvent.keyDown(document, { key: "r" })
    fireEvent.keyDown(document, { key: "r", metaKey: true })
    view.rerender(<><Btn onPress={onPress} /><input aria-label="field" /></>)
    const field = view.getByLabelText("field")
    field.focus()
    fireEvent.keyDown(field, { key: "r" })
    expect(onPress).not.toHaveBeenCalled()
  })

  it("under an open dialog, answers only from inside it", () => {
    const page = vi.fn()
    const inDialog = vi.fn()
    render(
      <>
        <Btn onPress={page} />
        <div role="dialog"><Btn onPress={inDialog} /></div>
      </>,
    )
    fireEvent.keyDown(document, { key: "r" })
    expect(page).not.toHaveBeenCalled()
    expect(inDialog).toHaveBeenCalledTimes(1)
  })

  it("leaves Enter to another focused control, but not to its own button", () => {
    const onPress = vi.fn()
    function EnterBtn() {
      const ref = useButtonHotkey("Enter", onPress, true)
      return <><button>Cancel</button><button ref={ref}>Mark read</button></>
    }
    const view = render(<EnterBtn />)
    const cancel = view.getByText("Cancel")
    cancel.focus()
    fireEvent.keyDown(cancel, { key: "Enter" })
    expect(onPress).not.toHaveBeenCalled()
    const own = view.getByText("Mark read")
    own.focus()
    fireEvent.keyDown(own, { key: "Enter" })
    document.body.focus()
    fireEvent.keyDown(document, { key: "Enter" })
    expect(onPress).toHaveBeenCalledTimes(2)
  })

  it("with aboveOverlays, answers outside an open dialog too", () => {
    const onPress = vi.fn()
    function Floating() {
      const ref = useButtonHotkey("z", onPress, true, { aboveOverlays: true })
      return <button ref={ref}>Undo</button>
    }
    const view = render(
      <>
        <Floating />
        <div role="dialog"><input aria-label="field" /></div>
      </>,
    )
    fireEvent.keyDown(document, { key: "z" })
    expect(onPress).toHaveBeenCalledTimes(1)
    // Still not while typing, even in the dialog.
    const field = view.getByLabelText("field")
    field.focus()
    fireEvent.keyDown(field, { key: "z" })
    expect(onPress).toHaveBeenCalledTimes(1)
  })
})
