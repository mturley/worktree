import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, render, cleanup, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { FollowingCmuxBanner } from "./FollowingCmuxBanner"
import { emitCmuxFocus, onCmuxFocus } from "../lib/cmuxFocusBus"
import { setFollowCmux } from "../hooks/useFollowCmux"
import { setCmuxTwoWaySync } from "../hooks/useCmuxTwoWaySync"
import { api } from "../api/client"

// Its own file: the page-load case needs a bus that has seen nothing yet,
// and the bus is module state.

const A = "/wt/repo/a"
const pageOf = (p: string) => `/worktree/${encodeURIComponent(p)}`
const scratch = { workspace_id: "W2", path: "", title: "notes-scratch", color: "#7048E8" }

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}><FollowingCmuxBanner /></QueryClientProvider>
    </MantineProvider>,
  )
}
const banner = () => document.querySelector("[data-following-cmux-banner]") as HTMLElement | null
const text = () => banner()?.querySelector("[data-banner-text]")?.textContent?.replace(/\s+/g, " ").trim()

beforeEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  window.history.replaceState({}, "", pageOf(A))
  act(() => setFollowCmux(true))
})
afterEach(() => {
  cleanup()
  act(() => setFollowCmux(false))
  act(() => setCmuxTwoWaySync(false))
})

describe("FollowingCmuxBanner, no worktree", () => {
  it("asks cmux where it is when a page loads already following, without moving the tab", async () => {
    const focused = vi.spyOn(api, "cmuxFocused").mockResolvedValue(scratch)
    const follower = vi.fn()
    const off = onCmuxFocus(follower)
    wrap()
    await waitFor(() => expect(banner()?.dataset.noWorktree).toBe("true"))
    expect(focused).toHaveBeenCalledTimes(1)
    expect(follower).not.toHaveBeenCalled()
    off()
  })

  it("turns yellow and names a workspace with no worktree", () => {
    wrap()
    act(() => emitCmuxFocus(scratch))
    expect(banner()?.dataset.noWorktree).toBe("true")
    expect(text()).toBe("Following cmux: notes-scratch has no worktree, staying on ⎇a.")
  })

  it("keeps the Synced prefix with two-way sync on", () => {
    act(() => setCmuxTwoWaySync(true))
    wrap()
    act(() => emitCmuxFocus(scratch))
    expect(text()).toBe("Synced with cmux: notes-scratch has no worktree, staying on ⎇a.")
  })

  it("says it is staying here on the home page", () => {
    window.history.replaceState({}, "", "/")
    wrap()
    act(() => emitCmuxFocus(scratch))
    expect(text()).toBe("Following cmux: notes-scratch has no worktree, staying here.")
  })

  it("goes back to normal when cmux lands on a worktree's workspace", () => {
    wrap()
    act(() => emitCmuxFocus(scratch))
    act(() => emitCmuxFocus({ workspace_id: "W1", path: A, title: "a", color: "" }))
    expect(banner()?.dataset.noWorktree).toBeUndefined()
    expect(text()).toBe("Following cmux: switching workspaces there opens their worktrees here.")
  })

  it("stays normal for an empty message (cmux unavailable)", () => {
    wrap()
    act(() => emitCmuxFocus({ workspace_id: "", path: "", title: "", color: "" }))
    expect(banner()?.dataset.noWorktree).toBeUndefined()
  })

  it("shows nothing once following is off", () => {
    wrap()
    act(() => emitCmuxFocus(scratch))
    act(() => setFollowCmux(false))
    expect(banner()).toBeNull()
  })
})
