import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PollLogEntry } from "../../api/types"
import { LogTab } from "./LogTab"

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
if (typeof window.ResizeObserver !== "function") {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
}

const watcherLog = vi.fn()
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return { api: { ...actual.api, watcherLog: (...a: unknown[]) => watcherLog(...a), watchers: async () => ({ watchers: [], polling: false }) } }
})

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MantineProvider>{ui}</MantineProvider>
    </QueryClientProvider>,
  )

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  watcherLog.mockReset()
})

const row = (id: number, over: Partial<PollLogEntry> = {}): PollLogEntry => ({
  id, ts: "2026-10-13T13:18:32.000000Z", source: "github", level: "info", kind: "poll",
  message: `row ${id}`, resources: [], ...over,
})

describe("LogTab", () => {
  it("source toggles narrow to one source at a time, and clicking the active one shows all", async () => {
    watcherLog.mockResolvedValue({ entries: [], has_more: false })
    const user = userEvent.setup()
    wrap(<LogTab />)
    await screen.findByText("No watcher activity recorded yet.")
    expect(watcherLog).toHaveBeenLastCalledWith(expect.objectContaining({ source: undefined }))
    await user.click(screen.getByRole("button", { name: "GitHub" }))
    expect(watcherLog).toHaveBeenLastCalledWith(expect.objectContaining({ source: "github" }))
    await user.click(screen.getByRole("button", { name: "Slack" }))
    expect(watcherLog).toHaveBeenLastCalledWith(expect.objectContaining({ source: "slack" }))
    expect(screen.getByRole("button", { name: "GitHub" })).toHaveAttribute("aria-pressed", "false")
    await user.click(screen.getByRole("button", { name: "Slack" }))
    expect(watcherLog).toHaveBeenLastCalledWith(expect.objectContaining({ source: undefined }))
  })

  it("renders http summaries and expands an error row", async () => {
    watcherLog.mockResolvedValue({
      entries: [row(2, { kind: "http", level: "error", method: "POST", endpoint: "api.github.com/graphql", http_status: 504,
        duration_ms: 12300, error_body: "Unicorn! · GitHub", resources: [{ type: "pr", id: "o/r#1", name: "Fix it" }] }), row(1)],
      has_more: false,
    })
    const user = userEvent.setup()
    wrap(<LogTab />)
    expect(await screen.findByText("POST api.github.com/graphql → 504 · 12.3 s")).toBeTruthy()
    expect(screen.queryByText("Unicorn! · GitHub")).toBeNull()
    await user.click(screen.getByText("POST api.github.com/graphql → 504 · 12.3 s"))
    expect(screen.getByText("Unicorn! · GitHub")).toBeTruthy()
    expect(screen.getByText("Fix it")).toBeTruthy()
  })

  it("polls with after_id and prepends without duplicates", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    watcherLog.mockResolvedValueOnce({ entries: [row(2), row(1)], has_more: false })
    watcherLog.mockResolvedValue({ entries: [row(3), row(2)], has_more: false })
    wrap(<LogTab />)
    await screen.findByText("row 2")
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(watcherLog).toHaveBeenLastCalledWith(expect.objectContaining({ after_id: 2 }))
    expect(await screen.findByText("row 3")).toBeTruthy()
    expect(screen.getAllByText("row 2")).toHaveLength(1)
  })

  it("filter change resets and refetches with level warn", async () => {
    watcherLog.mockResolvedValue({ entries: [row(1)], has_more: false })
    const user = userEvent.setup()
    wrap(<LogTab />)
    await screen.findByText("row 1")
    await user.click(screen.getByRole("switch", { name: "Errors & warnings only" }))
    expect(watcherLog).toHaveBeenLastCalledWith(expect.objectContaining({ level: "warn" }))
  })

  it("load older uses before_id", async () => {
    watcherLog.mockResolvedValueOnce({ entries: [row(5), row(4)], has_more: true })
    watcherLog.mockResolvedValue({ entries: [row(3)], has_more: false })
    const user = userEvent.setup()
    wrap(<LogTab />)
    await user.click(await screen.findByRole("button", { name: "Load older" }))
    expect(watcherLog).toHaveBeenLastCalledWith(expect.objectContaining({ before_id: 4 }))
    expect(await screen.findByText("row 3")).toBeTruthy()
  })

  it("shows empty state", async () => {
    watcherLog.mockResolvedValue({ entries: [], has_more: false })
    wrap(<LogTab />)
    expect(await screen.findByText("No watcher activity recorded yet.")).toBeTruthy()
  })

  it("shows an error when the initial fetch rejects", async () => {
    watcherLog.mockRejectedValue(new Error("boom"))
    wrap(<LogTab />)
    expect(await screen.findByText(/Couldn't load the watcher log: boom/)).toBeTruthy()
  })

  it("keeps rows when a poll rejects", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    watcherLog.mockResolvedValueOnce({ entries: [row(1)], has_more: false })
    watcherLog.mockRejectedValue(new Error("down"))
    wrap(<LogTab />)
    await screen.findByText("row 1")
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(await screen.findByText(/down/)).toBeTruthy()
    expect(screen.getByText("row 1")).toBeTruthy()
  })

  it("drops a stale load-older response after a filter change", async () => {
    let resolveOlder: (v: unknown) => void = () => {}
    watcherLog.mockResolvedValueOnce({ entries: [row(5), row(4)], has_more: true })
    watcherLog.mockImplementationOnce(() => new Promise((res) => { resolveOlder = res }))
    watcherLog.mockResolvedValue({ entries: [row(9)], has_more: false })
    const user = userEvent.setup()
    wrap(<LogTab />)
    await user.click(await screen.findByRole("button", { name: "Load older" }))
    await user.click(screen.getByRole("switch", { name: "Errors & warnings only" }))
    await screen.findByText("row 9")
    await act(async () => { resolveOlder({ entries: [row(3)], has_more: true }) })
    expect(screen.queryByText("row 3")).toBeNull()
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull()
  })
})
