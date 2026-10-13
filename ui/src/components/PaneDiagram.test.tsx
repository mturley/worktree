import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { PaneDiagram } from "./PaneDiagram"
import type { CmuxLayout, CmuxPane } from "../api/types"

const t = (n: number, type = "browser", selected = false, unread = false) => ({
  ref: `surface:${n}`,
  title: `Tab ${n}`,
  type,
  selected,
  unread,
})
const layout: CmuxLayout = { direction: "horizontal", split: 0.4, children: [{ pane: "pane:1" }, { pane: "pane:2" }] }

function wrap(panes: CmuxPane[], handlers: Partial<{ onSelect: () => void; onClose: () => void; onMove: () => void; onDragActiveChange: () => void }> = {}) {
  const props = { onSelect: vi.fn(), onClose: vi.fn(), onMove: vi.fn(), onDragActiveChange: vi.fn(), ...handlers }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <PaneDiagram workspaceId="W" layout={layout} panes={panes} {...props} />
      </QueryClientProvider>
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

  it("shows a dot on an unread tab and not on a read one", () => {
    wrap([
      { ref: "pane:1", focused: true, tabs: [t(1, "browser", false, true), t(2)] },
      { ref: "pane:2", focused: false, tabs: [] },
    ])
    const unreadRow = screen.getByRole("button", { name: /Switch to Tab 1/ }).closest(".cmux-tab-row")
    const readRow = screen.getByRole("button", { name: "Switch to Tab 2" }).closest(".cmux-tab-row")
    expect(unreadRow?.querySelector('[data-testid="cmux-unread-dot"]')).not.toBeNull()
    expect(readRow?.querySelector('[data-testid="cmux-unread-dot"]')).toBeNull()
  })

  it("mentions unread in the switch button's aria-label", () => {
    wrap([{ ref: "pane:1", focused: true, tabs: [t(1, "browser", false, true)] }, { ref: "pane:2", focused: false, tabs: [] }])
    expect(screen.getByRole("button", { name: "Switch to Tab 1 (unread)" })).toBeInTheDocument()
  })

  it("shows a dot on a collapsed group's link when it holds an unread tab", () => {
    const tabs = Array.from({ length: 12 }, (_, i) => t(i + 1, "browser", false, i === 10))
    wrap([{ ref: "pane:1", focused: true, tabs }, { ref: "pane:2", focused: false, tabs: [] }])
    const link = screen.getByRole("button", { name: "Show 2 more tabs" })
    expect(link.querySelector('[data-testid="cmux-unread-dot"]')).not.toBeNull()
  })

  it("shows no dot on a collapsed group's link when none of its tabs are unread", () => {
    const tabs = Array.from({ length: 12 }, (_, i) => t(i + 1))
    wrap([{ ref: "pane:1", focused: true, tabs }, { ref: "pane:2", focused: false, tabs: [] }])
    const link = screen.getByRole("button", { name: "Show 2 more tabs" })
    expect(link.querySelector('[data-testid="cmux-unread-dot"]')).toBeNull()
  })
})

describe("PaneDiagram tab peek", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // Advance fake time inside its own act, so React renders what the timers
  // set before the next step (a card's fetch starts only once it mounts).
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

  const panes = (): CmuxPane[] => [
    { ref: "pane:1", focused: true, tabs: [t(1, "terminal", true), t(2)] },
    { ref: "pane:2", focused: false, tabs: [] },
  ]

  it("does not fetch until a card opens, then fetches that tab only", async () => {
    const spy = vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hello from tab 1" })
    wrap(panes())
    expect(spy).not.toHaveBeenCalled()
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Switch to Tab 1" }))
    expect(await screen.findByText("hello from tab 1")).toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith("W", "surface:1")
  })

  it("opens the card below the row", async () => {
    vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hello from tab 1" })
    wrap(panes())
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Switch to Tab 1" }))
    const text = await screen.findByText("hello from tab 1")
    expect(text.closest("[data-position]")).toHaveAttribute("data-position", "bottom-start")
  })

  it("opens the card at once, with no hover delay", async () => {
    vi.useFakeTimers()
    vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hello from tab 1" })
    wrap(panes())
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Switch to Tab 1" }))
    // Only the popover's enter transition: 200ms in all, well inside the
    // 400ms open delay this replaced.
    await tick(100)
    await tick(100)
    expect(screen.getByText("hello from tab 1")).toBeInTheDocument()
  })

  // The card sits below its row, over the rows beneath. Moving into it hides
  // it, so sweeping the pointer down the list peeks at each tab in turn.
  it("hides the card when the pointer moves into it", async () => {
    vi.useFakeTimers()
    vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hello from tab 1" })
    wrap(panes())
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Switch to Tab 1" }))
    await tick(500)
    await tick(500)
    const card = screen.getByText("hello from tab 1").closest("[data-position]")!
    fireEvent.mouseEnter(card)
    await tick(500)
    await tick(500)
    expect(screen.queryByText("hello from tab 1")).not.toBeInTheDocument()
  })

  it("re-shows a browser tab's screenshot from cache, retaking it only once it is over 60s old", async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "browser", image: "data:image/png;base64,UE5H" })
    wrap([{ ref: "pane:1", focused: true, tabs: [t(1, "browser", true), t(2)] }, { ref: "pane:2", focused: false, tabs: [] }])
    const row = screen.getByRole("button", { name: "Switch to Tab 1" })
    const hover = async () => {
      fireEvent.mouseEnter(row)
      await tick(100)
      await tick(100)
    }
    const leave = async () => {
      fireEvent.mouseLeave(row)
      await tick(500)
      await tick(500)
    }
    await hover()
    expect(screen.getByRole("img", { name: "Tab 1" })).toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(1)
    await leave()

    // Re-hover within 60s: shown at once from cache, no new screenshot.
    await hover()
    expect(screen.getByRole("img", { name: "Tab 1" })).toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(1)
    await leave()

    // Past 60s: the cached image still shows at once, and a new one is taken.
    await tick(60_000)
    fireEvent.mouseEnter(row)
    await tick(100)
    await tick(100)
    expect(screen.getByRole("img", { name: "Tab 1" })).toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("closes the card when a drag starts", async () => {
    vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hello from tab 1" })
    wrap(panes())
    const row = screen.getByRole("button", { name: "Switch to Tab 1" })
    fireEvent.mouseEnter(row)
    expect(await screen.findByText("hello from tab 1")).toBeInTheDocument()
    vi.useFakeTimers()
    try {
      act(() => {
        fireEvent.mouseDown(row, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.mouseMove(document, { button: 0, clientX: 10, clientY: 30 })
      })
      // Past Popover's close transition, which keeps the dropdown mounted
      // until it finishes. Mid-drag, so dnd-kit's own timers are not at play.
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(screen.queryByText("hello from tab 1")).not.toBeInTheDocument()
      act(() => {
        fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 30 })
      })
    } finally {
      act(() => {
        vi.runAllTimers()
      })
    }
  })

  it("stops refreshing a terminal once its card closes", async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hello from tab 1" })
    wrap(panes())
    const row = screen.getByRole("button", { name: "Switch to Tab 1" })
    fireEvent.mouseEnter(row)
    // The 400ms open delay; then the card mounts and fetches.
    await tick(500)
    await tick(500)
    expect(screen.getByText("hello from tab 1")).toBeInTheDocument()
    // While open, the terminal refreshes every 5s.
    await tick(5000)
    expect(spy).toHaveBeenCalledTimes(2)
    fireEvent.mouseLeave(row)
    await tick(500)
    await tick(500)
    expect(screen.queryByText("hello from tab 1")).not.toBeInTheDocument()
    const calls = spy.mock.calls.length
    await tick(15000)
    expect(spy).toHaveBeenCalledTimes(calls)
  })

  it("switches straight to another row's card while one is open", async () => {
    vi.useFakeTimers()
    vi.spyOn(api, "cmuxPeek").mockImplementation(async (_id, surface) => ({ type: "terminal", text: `screen of ${surface}` }))
    wrap([
      { ref: "pane:1", focused: true, tabs: [t(1, "terminal", true), t(2, "terminal")] },
      { ref: "pane:2", focused: false, tabs: [] },
    ])
    const first = screen.getByRole("button", { name: "Switch to Tab 1" })
    fireEvent.mouseEnter(first)
    await tick(500)
    await tick(500)
    expect(screen.getByText("screen of surface:1")).toBeInTheDocument()
    fireEvent.mouseLeave(first)
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Switch to Tab 2" }))
    // 200ms in all, under the 400ms open delay: an open card hands over at
    // once rather than waiting to open afresh.
    await tick(100)
    await tick(100)
    expect(screen.getByText("screen of surface:2")).toBeInTheDocument()
  })

  it("shows no card on a device that cannot hover", async () => {
    const orig = window.matchMedia
    window.matchMedia = ((query: string) => ({
      ...orig(query),
      matches: query === "(hover: none)",
    })) as typeof window.matchMedia
    try {
      const spy = vi.spyOn(api, "cmuxPeek").mockResolvedValue({ type: "terminal", text: "hello from tab 1" })
      wrap(panes())
      fireEvent.mouseEnter(screen.getByRole("button", { name: "Switch to Tab 1" }))
      await new Promise((r) => setTimeout(r, 600))
      expect(screen.queryByText("hello from tab 1")).not.toBeInTheDocument()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.matchMedia = orig
    }
  })
})
