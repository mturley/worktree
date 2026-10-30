import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { setListeners, useListeners } from "./listenersStore"

describe("listenersStore", () => {
  it("is null before a snapshot, then reads the path's ports and range", () => {
    // Order matters: the store is module-level and starts empty.
    const { result } = renderHook(() => useListeners("/wt/a"))
    expect(result.current).toBeNull()
    const port = { port: 4091, addresses: ["[::1]"], pid: 1, process: "node", in_range: true }
    act(() => setListeners({ enabled: true, ports: { "/wt/a": [port] }, ranges: { "/wt/a": "4090-4099" } }))
    expect(result.current).toEqual({ enabled: true, ports: [port], range: "4090-4099" })
    const first = result.current
    const { result: other } = renderHook(() => useListeners("/wt/none"))
    expect(other.current).toEqual({ enabled: true, ports: [], range: null })
    // Stable between renders when nothing changed.
    const { result: again, rerender } = renderHook(() => useListeners("/wt/none"))
    const before = again.current
    rerender()
    expect(again.current).toBe(before)
    expect(result.current).toBe(first)
  })
})
