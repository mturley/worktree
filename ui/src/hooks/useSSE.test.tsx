import { afterEach, describe, it, expect, vi } from "vitest"
import { renderHook, cleanup } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useSSE } from "./useSSE"

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
  emit(type: string) {
    for (const fn of this.listeners[type] ?? []) fn({})
  }
  close() {
    this.closed = true
  }
}

afterEach(cleanup)

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
})
