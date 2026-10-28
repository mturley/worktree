import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useUnreadOnly } from "./useUnreadOnly"
import { UNREAD_ONLY_KEY } from "../lib/unreadOnlyPref"
import { useTaskListPrefs } from "./useTaskListPrefs"

beforeEach(() => window.localStorage.clear())

describe("useUnreadOnly", () => {
  it("keeps every user in this tab in step and persists the choice", () => {
    const a = renderHook(() => useUnreadOnly())
    const b = renderHook(() => useUnreadOnly())
    expect(a.result.current[0]).toBe(false)
    act(() => a.result.current[1](true))
    expect(b.result.current[0]).toBe(true)
    expect(window.localStorage.getItem(UNREAD_ONLY_KEY)).toBe("true")
  })

  it("follows another tab's change via the storage event", () => {
    const { result } = renderHook(() => useUnreadOnly())
    act(() => {
      window.localStorage.setItem(UNREAD_ONLY_KEY, "true")
      window.dispatchEvent(new StorageEvent("storage", { key: UNREAD_ONLY_KEY, newValue: "true" }))
    })
    expect(result.current[0]).toBe(true)
  })

  it("collapses the task panel when turned on, and restores it when turned off", () => {
    const u = renderHook(() => useUnreadOnly())
    const t = renderHook(() => useTaskListPrefs())
    act(() => u.result.current[1](true))
    expect(t.result.current[0].collapsed).toBe(true)
    act(() => u.result.current[1](false))
    expect(t.result.current[0].collapsed).toBe(false)
  })

  it("leaves the task panel alone when set to the value it already has", () => {
    const u = renderHook(() => useUnreadOnly())
    const t = renderHook(() => useTaskListPrefs())
    act(() => t.result.current[1]({ collapsed: true }))
    act(() => u.result.current[1](false))
    expect(t.result.current[0].collapsed).toBe(true)
  })
})
