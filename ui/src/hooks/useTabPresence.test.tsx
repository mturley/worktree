import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, cleanup, act } from "@testing-library/react"
import { api } from "../api/client"
import { useTabPresence } from "./useTabPresence"
import { TAB_ID } from "../lib/tabId"

vi.mock("../api/client", async (orig) => ({
  ...(await orig<typeof import("../api/client")>()),
  api: { tabPresence: vi.fn(() => Promise.resolve(null)) },
}))

afterEach(cleanup)

describe("useTabPresence", () => {
  it("reports route and visibility on mount and on visibility change", () => {
    renderHook(() => useTabPresence())
    expect(api.tabPresence).toHaveBeenLastCalledWith({ tab: TAB_ID, route: window.location.pathname, visible: true })
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    act(() => { document.dispatchEvent(new Event("visibilitychange")) })
    expect(api.tabPresence).toHaveBeenLastCalledWith({ tab: TAB_ID, route: window.location.pathname, visible: false })
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
  })
})
