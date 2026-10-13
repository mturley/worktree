import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WatcherLogButton } from "./WatcherLogButton"

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

const watchedResources = vi.fn()
const watcherLog = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      watchedResources: (...a: unknown[]) => watchedResources(...a),
      watcherLog: (...a: unknown[]) => watcherLog(...a),
    },
  }
})

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MantineProvider>{ui}</MantineProvider>
    </QueryClientProvider>,
  )

beforeEach(() => {
  watchedResources.mockResolvedValue({ resources: [] })
  watcherLog.mockResolvedValue({ entries: [], has_more: false })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  watchedResources.mockReset()
  watcherLog.mockReset()
})

describe("WatcherLogButton", () => {
  it("fetches nothing until opened", () => {
    wrap(<WatcherLogButton scope={{}} />)
    expect(watcherLog).not.toHaveBeenCalled()
    expect(watchedResources).not.toHaveBeenCalled()
  })

  it("opens scoped to a resource and can widen to all", async () => {
    const user = userEvent.setup()
    wrap(<WatcherLogButton scope={{ worktree: "/w", resource: { type: "pr", id: "o/r#1", name: "Fix it" } }} />)
    await user.click(screen.getByRole("button", { name: "Watcher log" }))
    expect(await screen.findByText("This PR: Fix it")).toBeTruthy()
    expect(watcherLog).toHaveBeenCalledWith({ worktree: "/w", resource: { type: "pr", id: "o/r#1", name: "Fix it" } }, expect.anything())
    await user.click(screen.getByRole("button", { name: "Show all" }))
    expect(await screen.findByText("All resources")).toBeTruthy()
    expect(watcherLog).toHaveBeenLastCalledWith({}, expect.anything())
  })

  it("labels a worktree scope", async () => {
    const user = userEvent.setup()
    wrap(<WatcherLogButton scope={{ worktree: "/w" }} />)
    await user.click(screen.getByRole("button", { name: "Watcher log" }))
    expect(await screen.findByText("This worktree")).toBeTruthy()
  })

  it("stops requesting after close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    wrap(<WatcherLogButton scope={{}} />)
    await user.click(screen.getByRole("button", { name: "Watcher log" }))
    await screen.findByText("All resources")
    await user.keyboard("{Escape}")
    const calls = watcherLog.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })
    expect(watcherLog.mock.calls.length).toBe(calls)
  })
})
