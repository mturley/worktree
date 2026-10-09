import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { CmuxFollower, worktreeAt } from "./CmuxFollower"
import { FollowCmuxToggle } from "./FollowCmuxToggle"
import { emitCmuxFocus } from "../lib/cmuxFocusBus"
import { setFollowCmux, FOLLOW_CMUX_KEY } from "../hooks/useFollowCmux"
import { useUnsavedChanges } from "../lib/unsavedChanges"
import { api } from "../api/client"
import { navigate } from "wouter/use-browser-location"

const A = "/wt/repo/a"
const B = "/wt/repo/b"
const pageOf = (p: string) => `/worktree/${encodeURIComponent(p)}`

function Dirty() {
  useUnsavedChanges(true)
  return null
}

const wrap = (children: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineProvider>,
  )
}

const focus = (path: string) => act(() => emitCmuxFocus({ workspace_id: "W", path }))

beforeEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  window.history.replaceState({}, "", pageOf(A))
})
afterEach(() => {
  cleanup()
  act(() => setFollowCmux(false))
})

describe("worktreeAt", () => {
  it("reads the worktree path off a detail page location", () => {
    expect(worktreeAt(pageOf(A))).toBe(A)
    expect(worktreeAt("/")).toBeNull()
  })
})

describe("CmuxFollower", () => {
  it("does nothing while following is off", () => {
    wrap(<CmuxFollower />)
    focus(B)
    expect(window.location.pathname).toBe(pageOf(A))
  })

  it("opens the focused workspace's worktree when following", () => {
    act(() => setFollowCmux(true))
    wrap(<CmuxFollower />)
    focus(B)
    expect(window.location.pathname).toBe(pageOf(B))
  })

  it("keeps following across its own navigation", () => {
    act(() => setFollowCmux(true))
    wrap(<CmuxFollower />)
    focus(B)
    focus(A)
    expect(window.location.pathname).toBe(pageOf(A))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("true")
  })

  it("turns off when the user leaves a worktree page for the list", () => {
    act(() => setFollowCmux(true))
    wrap(<CmuxFollower />)
    act(() => navigate("/"))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("false")
  })

  it("turns off when the user opens another worktree themselves", () => {
    act(() => setFollowCmux(true))
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("false")
  })

  it("stays on when the user goes from the list to a worktree", () => {
    window.history.replaceState({}, "", "/")
    act(() => setFollowCmux(true))
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("true")
  })

  it("stays put for a workspace with no worktree", () => {
    act(() => setFollowCmux(true))
    wrap(<CmuxFollower />)
    focus("")
    expect(window.location.pathname).toBe(pageOf(A))
  })

  it("asks before discarding unsaved changes; discarding follows", async () => {
    act(() => setFollowCmux(true))
    wrap(<><CmuxFollower /><Dirty /></>)
    focus(B)
    expect(window.location.pathname).toBe(pageOf(A))
    await userEvent.click(await screen.findByRole("button", { name: /discard and follow/i }))
    expect(window.location.pathname).toBe(pageOf(B))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("true")
  })

  it("staying keeps the page and turns following off", async () => {
    act(() => setFollowCmux(true))
    wrap(<><CmuxFollower /><Dirty /></>)
    focus(B)
    await userEvent.click(await screen.findByRole("button", { name: /stay and stop following/i }))
    expect(window.location.pathname).toBe(pageOf(A))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("false")
    focus(B)
    expect(window.location.pathname).toBe(pageOf(A))
  })
})

describe("FollowCmuxToggle", () => {
  it("is hidden when the server is not running in cmux", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    wrap(<FollowCmuxToggle />)
    await act(async () => {})
    expect(screen.queryByRole("switch", { name: /follow cmux/i })).toBeNull()
  })

  it("opens cmux's current worktree when turned on", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    const focused = vi.spyOn(api, "cmuxFocused").mockResolvedValue({ workspace_id: "W", path: B })
    wrap(<><CmuxFollower /><FollowCmuxToggle /></>)
    await userEvent.click(await screen.findByRole("switch", { name: /follow cmux/i }))
    expect(focused).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(window.location.pathname).toBe(pageOf(B)))
    // Its own navigation: following stays on.
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("true")
  })

  it("does not ask cmux when turned off", async () => {
    act(() => setFollowCmux(true))
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    const focused = vi.spyOn(api, "cmuxFocused").mockResolvedValue({ workspace_id: "W", path: B })
    wrap(<><CmuxFollower /><FollowCmuxToggle /></>)
    await userEvent.click(await screen.findByRole("switch", { name: /follow cmux/i }))
    expect(focused).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(pageOf(A))
  })

  it("persists to sessionStorage when turned on", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    vi.spyOn(api, "cmuxFocused").mockResolvedValue({ workspace_id: "", path: "" })
    wrap(<FollowCmuxToggle />)
    await userEvent.click(await screen.findByRole("switch", { name: /follow cmux/i }))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("true")
  })
})
