import { afterEach, describe, it, expect, vi } from "vitest"
import { renderHook, cleanup } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useSSE } from "./useSSE"
import { api } from "../api/client"

const streams = vi.hoisted(() => ({ pause: true }))
vi.mock("../lib/backgroundStreams", async (orig) => ({
  ...(await orig<typeof import("../lib/backgroundStreams")>()),
  streamsPauseWhenHidden: () => streams.pause,
}))

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
  document.dispatchEvent(new Event("visibilitychange"))
}

vi.mock("../api/client", async (orig) => ({
  ...(await orig<typeof import("../api/client")>()),
  api: { tabAck: vi.fn(() => Promise.resolve(null)) },
}))

/**
 * Minimal EventSource stand-in: records listeners so a test can fire
 * `events_new` the way the server would.
 */
class FakeEventSource {
  static last: FakeEventSource | null = null
  listeners: Record<string, ((e: unknown) => void)[]> = {}
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.last = this
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  emit(type: string, data?: string) {
    for (const fn of this.listeners[type] ?? []) fn({ data })
  }
  close() {
    this.closed = true
  }
}

afterEach(() => {
  cleanup()
  streams.pause = true
  setVisibility("visible")
  vi.useRealTimers()
})

function renderSSE() {
  vi.stubGlobal("EventSource", FakeEventSource)
  const qc = new QueryClient()
  const invalidate = vi.spyOn(qc, "invalidateQueries")
  renderHook(() => useSSE(), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  })
  return invalidate
}

const invalidatedKeys = (invalidate: ReturnType<typeof renderSSE>) =>
  invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))

describe("useSSE", () => {
  it("invalidates resources as well as timeline and worktrees on events_new", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")

    renderHook(() => useSSE(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    FakeEventSource.last!.emit("events_new")

    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
    expect(keys).toContain(JSON.stringify(["timeline"]))
    expect(keys).toContain(JSON.stringify(["worktrees"]))
    // Without this, a detail page's resource cards keep showing stale state
    // (PR status, Jira status, thread reply counts) until something forces a
    // refetch — the cards are the surface most obviously "wrong" after an
    // event arrives.
    expect(keys).toContain(JSON.stringify(["resources"]))
  })

  it("invalidates tasks, worktrees and resources on tasks_changed", () => {
    const invalidate = renderSSE()
    FakeEventSource.last!.emit("tasks_changed", "{}")
    const keys = invalidatedKeys(invalidate)
    for (const k of [["tasks"], ["worktrees"], ["resources"]]) expect(keys).toContain(JSON.stringify(k))
  })

  it("invalidates the session query on a stream error", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")

    renderHook(() => useSSE(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    // A stream error can mean the session was revoked on another device;
    // re-checking it lets the login screen show instead of a stale tab.
    FakeEventSource.last!.onerror?.()

    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
    expect(keys).toContain(JSON.stringify(["session"]))
  })
  it("names this tab on the stream URL", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const qc = new QueryClient()
    renderHook(() => useSSE(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    const url = new URL(FakeEventSource.last!.url, "http://x")
    expect(url.pathname).toBe("/api/stream")
    expect(url.searchParams.get("tab")).toBeTruthy()
    expect(url.searchParams.get("route")).toBe(window.location.pathname)
  })

  it("acks shown:false for a notification it cannot show", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("Notification", undefined)
    const qc = new QueryClient()
    renderHook(() => useSSE(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
    FakeEventSource.last!.emit("notification", JSON.stringify({ id: "n9", title: "t", subtitle: "", body: "", worktree_path: "/w", resource_type: "", resource_id: "", tag: "x" }))
    expect(api.tabAck).toHaveBeenCalledWith(expect.objectContaining({ notification_id: "n9", shown: false }))
  })
  describe("over plain HTTP", () => {
    it("closes the stream while hidden and reopens it, catching up, when shown", () => {
      const invalidate = renderSSE()
      const first = FakeEventSource.last!

      setVisibility("hidden")
      expect(first.closed).toBe(true)

      invalidate.mockClear()
      setVisibility("visible")
      expect(FakeEventSource.last).not.toBe(first)
      expect(FakeEventSource.last!.closed).toBe(false)
      // Events that arrived while it was disconnected never reached this tab.
      const keys = invalidatedKeys(invalidate)
      expect(keys).toContain(JSON.stringify(["timeline"]))
      expect(keys).toContain(JSON.stringify(["worktrees"]))
      expect(keys).toContain(JSON.stringify(["resources"]))
      expect(keys).toContain(JSON.stringify(["tasks"]))
    })

    it("opens no stream for a tab loaded in the background until it is shown", () => {
      FakeEventSource.last = null
      setVisibility("hidden")
      renderSSE()
      expect(FakeEventSource.last).toBeNull()

      setVisibility("visible")
      expect(FakeEventSource.last).not.toBeNull()
    })

    it("does not reconnect after an error while hidden", () => {
      vi.useFakeTimers()
      renderSSE()
      const first = FakeEventSource.last!
      first.onerror?.()
      setVisibility("hidden")
      vi.advanceTimersByTime(10_000)
      expect(FakeEventSource.last).toBe(first)
    })
  })

  it("keeps the stream open while hidden when streams don't pause (HTTPS)", () => {
    streams.pause = false
    renderSSE()
    const first = FakeEventSource.last!
    setVisibility("hidden")
    expect(first.closed).toBe(false)
    setVisibility("visible")
    expect(FakeEventSource.last).toBe(first)
  })
})
