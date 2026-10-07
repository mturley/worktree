import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { PaneDiagram } from "./PaneDiagram"
import type { CmuxLayout, CmuxPane } from "../api/types"

const t = (n: number, type = "browser", selected = false) => ({ ref: `surface:${n}`, title: `Tab ${n}`, type, selected })
const layout: CmuxLayout = { direction: "horizontal", split: 0.4, children: [{ pane: "pane:1" }, { pane: "pane:2" }] }

function wrap(panes: CmuxPane[], handlers: Partial<{ onSelect: () => void; onClose: () => void; onMove: () => void; onDragActiveChange: () => void }> = {}) {
  const props = { onSelect: vi.fn(), onClose: vi.fn(), onMove: vi.fn(), onDragActiveChange: vi.fn(), ...handlers }
  const view = render(
    <MantineProvider>
      <PaneDiagram layout={layout} panes={panes} {...props} />
    </MantineProvider>,
  )
  return { ...view, ...props }
}

describe("PaneDiagram", () => {
  it("draws the split and its panes with their tabs", () => {
    const { container } = wrap([
      { ref: "pane:1", focused: true, tabs: [t(1, "terminal", true)] },
      { ref: "pane:2", focused: false, tabs: [t(2, "browser", true), t(3, "markdown")] },
    ])
    expect(container.querySelector('[data-split="horizontal"]')).not.toBeNull()
    expect(container.querySelector('[data-pane="pane:1"]')).toHaveTextContent("Tab 1")
    expect(container.querySelector('[data-pane="pane:2"]')).toHaveTextContent("Tab 3")
  })

  it("collapses tabs past 10 and expands them in place, with Show fewer", async () => {
    const user = userEvent.setup()
    const tabs = Array.from({ length: 12 }, (_, i) => t(i + 1, "browser", i === 0))
    wrap([{ ref: "pane:1", focused: true, tabs }, { ref: "pane:2", focused: false, tabs: [t(99)] }])
    expect(screen.queryByText("Tab 11")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Show 2 more tabs" }))
    expect(screen.getByText("Tab 12")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Show fewer" }))
    expect(screen.queryByText("Tab 12")).not.toBeInTheDocument()
  })

  it("offers groups both above and below a selected tab far down", () => {
    const tabs = Array.from({ length: 30 }, (_, i) => t(i + 1, "browser", i === 14))
    wrap([{ ref: "pane:1", focused: true, tabs }, { ref: "pane:2", focused: false, tabs: [] }])
    expect(screen.getAllByRole("button", { name: "Show 10 more tabs" })).toHaveLength(2)
    expect(screen.getByText("Tab 15")).toBeInTheDocument()
  })

  it("forgets expansion when remounted", async () => {
    const user = userEvent.setup()
    const tabs = Array.from({ length: 11 }, (_, i) => t(i + 1))
    const panes = [{ ref: "pane:1", focused: true, tabs }, { ref: "pane:2", focused: false, tabs: [] }]
    const first = wrap(panes)
    await user.click(screen.getByRole("button", { name: "Show 1 more tab" }))
    expect(screen.getByText("Tab 11")).toBeInTheDocument()
    first.unmount()
    wrap(panes)
    expect(screen.queryByText("Tab 11")).not.toBeInTheDocument()
  })

  it("switches to a tab on click", async () => {
    const user = userEvent.setup()
    const { onSelect } = wrap([{ ref: "pane:1", focused: true, tabs: [t(1)] }, { ref: "pane:2", focused: false, tabs: [t(2)] }])
    await user.click(screen.getByRole("button", { name: "Switch to Tab 2" }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ ref: "surface:2" }))
  })

  it("closes a browser tab at once, but asks before closing a terminal", async () => {
    const user = userEvent.setup()
    const { onClose } = wrap([
      { ref: "pane:1", focused: true, tabs: [t(1, "terminal")] },
      { ref: "pane:2", focused: false, tabs: [t(2, "browser")] },
    ])
    await user.click(screen.getByRole("button", { name: "Close Tab 2" }))
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole("button", { name: "Close Tab 1" }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/close terminal "Tab 1"\?/i)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole("button", { name: "Close Tab 1" }))
    await user.click(await screen.findByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenLastCalledWith(expect.objectContaining({ ref: "surface:1" }))
  })

  it("renders an empty pane and unknown tab types without failing", () => {
    const { container } = wrap([
      { ref: "pane:1", focused: true, tabs: [t(1, "simulator")] },
      { ref: "pane:2", focused: false, tabs: [] },
    ])
    expect(container.querySelector('[data-pane="pane:2"]')).toHaveTextContent("No tabs")
    expect(screen.getByText("Tab 1")).toBeInTheDocument()
  })

  it("bolds the selected tab", () => {
    wrap([{ ref: "pane:1", focused: true, tabs: [t(1), t(2, "browser", true)] }, { ref: "pane:2", focused: false, tabs: [] }])
    expect(screen.getByText("Tab 2")).toHaveAttribute("data-selected", "true")
    expect(screen.getByText("Tab 1")).not.toHaveAttribute("data-selected")
  })

  it("makes every visible row draggable and every pane a drop target", () => {
    const { container } = wrap([
      { ref: "pane:1", focused: true, tabs: [t(1), t(2)] },
      { ref: "pane:2", focused: false, tabs: [] },
    ])
    // dnd-kit's sortable attributes on each row.
    expect(container.querySelectorAll('[aria-roledescription="sortable"]')).toHaveLength(2)
    expect(container.querySelector('[data-pane="pane:2"]')).toHaveAttribute("data-droppable", "true")
  })

  it("reports drag start/end via onDragActiveChange", () => {
    // Fake timers because dnd-kit removes its post-drag click-swallowing
    // listener 50ms after the drag ends. Left on real timers, that listener
    // outlives this test and can interfere with whichever test runs next
    // (its Popover/click handling), regardless of this test's own position.
    vi.useFakeTimers()
    try {
      const { onDragActiveChange } = wrap([{ ref: "pane:1", focused: true, tabs: [t(1), t(2)] }, { ref: "pane:2", focused: false, tabs: [] }])
      const row = screen.getByRole("button", { name: "Switch to Tab 1" })
      act(() => {
        fireEvent.mouseDown(row, { button: 0, clientX: 10, clientY: 10 })
        // Past the 4px activation distance: a real drag, unlike the short-press test above.
        fireEvent.mouseMove(document, { button: 0, clientX: 10, clientY: 30 })
      })
      expect(onDragActiveChange).toHaveBeenLastCalledWith(true)
      act(() => {
        fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 30 })
      })
      expect(onDragActiveChange).toHaveBeenLastCalledWith(false)
    } finally {
      // Flush dnd-kit's listener-removal timer (and DragOverlay's drop
      // animation) here, inside the test that caused them, instead of
      // leaking them into whatever test runs next.
      act(() => {
        vi.runAllTimers()
      })
      vi.useRealTimers()
    }
  })

  it("asks before closing a browser tab that is the UI's own hosting page", async () => {
    const user = userEvent.setup()
    const own = { ...t(1, "browser"), url: `${window.location.origin}/worktree/x` }
    const { onClose } = wrap([
      { ref: "pane:1", focused: true, tabs: [own] },
      { ref: "pane:2", focused: false, tabs: [] },
    ])
    await user.click(screen.getByRole("button", { name: "Close Tab 1" }))
    expect(onClose).not.toHaveBeenCalled()
    expect(await screen.findByText(/close this page's tab "Tab 1"\?/i, {}, { timeout: 3000 })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ ref: "surface:1" }))
  })

  it("makes the collapsed top group's link its own drop target", async () => {
    const user = userEvent.setup()
    const tabs = Array.from({ length: 12 }, (_, i) => t(i + 1, "browser", i === 11))
    const { container } = wrap([{ ref: "pane:1", focused: true, tabs }, { ref: "pane:2", focused: false, tabs: [] }])
    // Selected tab (12) is last, so the window shows the end and the first 2
    // tabs collapse into the top "before" group.
    const topLink = await screen.findByRole("button", { name: "Show 2 more tabs" })
    expect(topLink).toHaveAttribute("data-droppable", "true")
    // Expanding it (an ordinary click) still works — the droppable id doesn't
    // interfere with the existing expand/collapse behaviour.
    await user.click(topLink)
    expect(container.querySelector('[data-pane="pane:1"]')).toHaveTextContent("Tab 1")
  })

  it("still switches tabs on a press too short to be a drag", () => {
    const { onSelect, onMove } = wrap([{ ref: "pane:1", focused: true, tabs: [t(1), t(2)] }, { ref: "pane:2", focused: false, tabs: [] }])
    const row = screen.getByRole("button", { name: "Switch to Tab 1" })
    act(() => {
      fireEvent.mouseDown(row, { button: 0, clientX: 10, clientY: 10 })
      fireEvent.mouseMove(document, { button: 0, clientX: 11, clientY: 11 })
      fireEvent.mouseUp(document, { button: 0, clientX: 11, clientY: 11 })
    })
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onMove).not.toHaveBeenCalled()
  })
})
