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
})
