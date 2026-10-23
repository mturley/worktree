import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { Notifications, notifications, notificationsStore } from "@mantine/notifications"
import { showUndoToast, UNDO_WINDOW_MS } from "./UndoToast"

function wrap() {
  return render(
    <MantineProvider>
      <Notifications />
    </MantineProvider>,
  )
}

/**
 * The undo toasts in Mantine's store. The store, not the DOM: jsdom never
 * ends the exit transition, so a hidden toast's markup lingers.
 */
const undoToasts = () => notificationsStore.getState().notifications.filter((n) => String(n.id).startsWith("undo-"))

afterEach(() => {
  cleanup()
  notifications.clean()
  vi.useRealTimers()
})

describe("showUndoToast", () => {
  it("ends at UNDO_WINDOW_MS", async () => {
    vi.useFakeTimers()
    wrap()
    act(() => showUndoToast({ message: "Checked “b”", undo: async () => {} }))
    act(() => vi.advanceTimersByTime(UNDO_WINDOW_MS - 100))
    expect(undoToasts()).toHaveLength(1)
    act(() => vi.advanceTimersByTime(200))
    expect(undoToasts()).toHaveLength(0)
  })

  it("ends at UNDO_WINDOW_MS even while hovered", async () => {
    vi.useFakeTimers()
    wrap()
    act(() => showUndoToast({ message: "Marked “a” done", undo: async () => {} }))
    const text = screen.getByText("Marked “a” done")
    // Mantine pauses a notification's auto-close while the pointer is over it.
    fireEvent.mouseEnter(text.closest(".mantine-Notification-root") ?? text)
    act(() => vi.advanceTimersByTime(UNDO_WINDOW_MS - 100))
    expect(undoToasts()).toHaveLength(1)
    act(() => vi.advanceTimersByTime(200))
    expect(undoToasts()).toHaveLength(0)
  })

  it("answers Z while a modal is open", async () => {
    const undo = vi.fn(async () => {})
    render(
      <MantineProvider>
        <Notifications />
        <div role="dialog" aria-label="Task">
          <button>inside the modal</button>
        </div>
      </MantineProvider>,
    )
    act(() => showUndoToast({ message: "Marked “a” done", undo }))
    await screen.findByText("Marked “a” done")
    await act(async () => {
      fireEvent.keyDown(document, { key: "z" })
    })
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it("Z undoes only the newest toast, then the next newest", async () => {
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})
    wrap()
    act(() => showUndoToast({ message: "Marked “a” done", undo: first }))
    act(() => showUndoToast({ message: "Marked “b” done", undo: second }))
    await screen.findByText("Marked “b” done")
    await act(async () => {
      fireEvent.keyDown(document, { key: "z" })
    })
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    expect(undoToasts()).toHaveLength(1)
    await act(async () => {
      fireEvent.keyDown(document, { key: "z" })
    })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("clears its deadline when it closes early", () => {
    vi.useFakeTimers()
    const set = vi.spyOn(window, "setTimeout")
    const clear = vi.spyOn(window, "clearTimeout")
    wrap()
    act(() => showUndoToast({ message: "Deleted “a”", undo: async () => {} }))
    const deadline = set.mock.results[0]?.value
    expect(deadline).toBeDefined()
    expect(clear).not.toHaveBeenCalledWith(deadline)
    act(() => {
      notifications.hide(String(undoToasts()[0].id))
    })
    expect(clear).toHaveBeenCalledWith(deadline)
    set.mockRestore()
    clear.mockRestore()
  })
})
