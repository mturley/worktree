import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CmuxPanel } from "./CmuxPanel"
import { api } from "../api/client"
import type { CmuxTreeResponse } from "../api/types"

const tree = (over: Partial<CmuxTreeResponse["workspaces"][number]> = {}): CmuxTreeResponse => ({
  available: true,
  workspaces: [{
    id: "W", ref: "workspace:1", title: "Alpha", color: "#AD1457", selected: false,
    layout: { pane: "pane:1" },
    panes: [{ ref: "pane:1", focused: true, tabs: [
      { ref: "surface:1", title: "Tab 1", type: "browser", selected: true },
      { ref: "surface:2", title: "Tab 2", type: "browser", selected: false },
    ] }],
    ...over,
  }],
})

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <CmuxPanel path="/wt/a" branch="b" />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

const ok = { ok: true }

describe("CmuxPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    vi.spyOn(api, "cmuxGroups").mockResolvedValue({ groups: [], colors: [{ name: "Teal", hex: "#008080" }] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("offers Create when no workspace matches", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue({ available: true, workspaces: [] })
    wrap()
    expect(await screen.findByText(/no cmux workspace/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /create cmux workspace/i })).toBeInTheDocument()
  })

  it("shows each workspace's title and diagram", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    wrap()
    expect(await screen.findByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Tab 2")).toBeInTheDocument()
  })

  it("says so when one workspace's panes could not be read", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(tree({ layout: undefined, panes: undefined, error: "workspace not found" }))
    wrap()
    expect(await screen.findByText(/could not read panes: workspace not found/i)).toBeInTheDocument()
  })

  it("renames on Enter, cancels on Esc", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    const rename = vi.spyOn(api, "cmuxRename").mockResolvedValue(ok)
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "Rename workspace" }))
    const input = screen.getByRole("textbox", { name: "Workspace title" })
    await user.clear(input)
    await user.type(input, "Beta{Escape}")
    expect(rename).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Rename workspace" }))
    await user.clear(screen.getByRole("textbox", { name: "Workspace title" }))
    await user.type(screen.getByRole("textbox", { name: "Workspace title" }), "Beta{Enter}")
    expect(rename).toHaveBeenCalledWith("W", "Beta")
  })

  it("sets a swatch colour, and clears", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    const color = vi.spyOn(api, "cmuxColor").mockResolvedValue(ok)
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "Workspace color" }))
    await user.click(await screen.findByRole("button", { name: "Teal" }))
    expect(color).toHaveBeenLastCalledWith("W", "#008080")
    await user.click(screen.getByRole("button", { name: "Workspace color" }))
    await user.click(await screen.findByRole("button", { name: "Clear" }))
    expect(color).toHaveBeenLastCalledWith("W", "")
  })

  it("switches to a tab", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    const focus = vi.spyOn(api, "cmuxFocusTab").mockResolvedValue(ok)
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "Switch to Tab 2" }))
    expect(focus).toHaveBeenCalledWith("W", "surface:2")
  })

  it("sends what the user saw with a close, and shows a stale refusal after refetching", async () => {
    const getTree = vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    const close = vi.spyOn(api, "cmuxCloseTab").mockResolvedValue({
      ok: false, stale: true, error: "That tab changed since the list loaded. Check it and try again.",
    })
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "Close Tab 2" }))
    expect(close).toHaveBeenCalledWith("W", { surface: "surface:2", type: "browser", title: "Tab 2" })
    expect(await screen.findByText(/that tab changed/i)).toBeInTheDocument()
    await waitFor(() => expect(getTree.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it("closes a tab optimistically: it disappears before the request resolves", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    let resolveClose: (r: { ok: boolean }) => void = () => {}
    vi.spyOn(api, "cmuxCloseTab").mockReturnValue(new Promise((resolve) => { resolveClose = resolve }))
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "Close Tab 2" }))
    await waitFor(() => expect(screen.queryByText("Tab 2")).not.toBeInTheDocument())
    resolveClose({ ok: true })
  })

  it("keeps showing cached panes after a background refetch fails", async () => {
    const getTree = vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    const user = userEvent.setup()
    wrap()
    expect(await screen.findByText("Alpha")).toBeInTheDocument()

    // A background poll failure sets isError, but react-query keeps the last
    // good data cached — the panel must not blank out over it.
    getTree.mockRejectedValueOnce(new Error("boom"))
    const focus = vi.spyOn(api, "cmuxFocusTab").mockResolvedValue(ok)
    await user.click(screen.getByRole("button", { name: "Switch to Tab 2" }))
    expect(focus).toHaveBeenCalled()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.queryByText(/could not load the cmux workspace/i)).not.toBeInTheDocument()
  })

  it("pauses the poll while a drag is in progress", async () => {
    const getTree = vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    wrap()
    expect(await screen.findByText("Tab 1")).toBeInTheDocument()

    // Fake timers because dnd-kit removes its post-drag click-swallowing
    // listener 50ms after the drag ends; the `finally` below flushes it
    // explicitly (rather than relying on the later 5s advances to happen to
    // cover it) so it can never outlive this test regardless of what else
    // changes here later.
    vi.useFakeTimers()
    try {
      getTree.mockClear()

      const row = screen.getByRole("button", { name: "Switch to Tab 1" })
      await act(async () => {
        fireEvent.mouseDown(row, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.mouseMove(document, { button: 0, clientX: 10, clientY: 30 })
      })

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(getTree).not.toHaveBeenCalled()

      await act(async () => {
        fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 30 })
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(getTree).toHaveBeenCalled()
    } finally {
      // Not vi.runAllTimers()/runAllTimersAsync(): the poll's own
      // refetchInterval keeps rescheduling itself forever, so "run every
      // timer" never terminates here. A bounded advance is enough to clear
      // dnd-kit's 50ms listener-removal timer.
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      vi.useRealTimers()
    }
  })

  it("switches to this cmux workspace", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    const select = vi.spyOn(api, "cmuxSelect").mockResolvedValue(ok)
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "Switch cmux" }))
    expect(select).toHaveBeenCalledWith("W")
  })

  it("shows Current, disabled, for the already-selected workspace", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(tree({ selected: true }))
    wrap()
    const button = await screen.findByRole("button", { name: "Current" })
    expect(button).toBeDisabled()
  })

  it("shows the error line when switching fails", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    vi.spyOn(api, "cmuxSelect").mockResolvedValue({ ok: false, error: "boom" })
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "Switch cmux" }))
    expect(await screen.findByText("boom")).toBeInTheDocument()
  })

  it("clears an earlier error after a successful action", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(tree())
    vi.spyOn(api, "cmuxFocusTab").mockResolvedValueOnce({ ok: false, error: "boom" }).mockResolvedValue(ok)
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: "Switch to Tab 2" }))
    expect(await screen.findByText("boom")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Switch to Tab 2" }))
    await waitFor(() => expect(screen.queryByText("boom")).not.toBeInTheDocument())
  })
})
