import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from "vitest"
import { act, render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { CmuxFollower, TWO_WAY_GUARD_MS, worktreeAt } from "./CmuxFollower"
import { FollowCmuxToggle } from "./FollowCmuxToggle"
import { FollowingCmuxBanner } from "./FollowingCmuxBanner"
import { emitCmuxFocus } from "../lib/cmuxFocusBus"
import { setFollowCmux, FOLLOW_CMUX_KEY } from "../hooks/useFollowCmux"
import { setCmuxTwoWaySync } from "../hooks/useCmuxTwoWaySync"
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
  act(() => setCmuxTwoWaySync(false))
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

describe("CmuxFollower, two-way sync", () => {
  const C = "/wt/repo/c"
  const cmuxState = (bSelected = false) => ({
    available: true,
    matches: {
      [A]: [{ ref: "workspace:1", title: "a", selected: !bSelected }],
      [B]: [{ ref: "workspace:2", title: "b", selected: bSelected }],
    },
  })
  const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  let cmux: MockInstance<typeof api.cmux>
  let select: MockInstance<typeof api.cmuxSelect>

  beforeEach(() => {
    act(() => setFollowCmux(true))
    act(() => setCmuxTwoWaySync(true))
    cmux = vi.spyOn(api, "cmux").mockResolvedValue(cmuxState())
    select = vi.spyOn(api, "cmuxSelect").mockResolvedValue({ ok: true })
  })

  it("switches cmux when the user opens another worktree", async () => {
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await waitFor(() => expect(select).toHaveBeenCalledWith("workspace:2"))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("true")
  })

  it("switches cmux when going from the list to a worktree", async () => {
    window.history.replaceState({}, "", "/")
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await waitFor(() => expect(select).toHaveBeenCalledWith("workspace:2"))
  })

  it("keeps following and leaves cmux alone on the home page", async () => {
    wrap(<CmuxFollower />)
    act(() => navigate("/"))
    await tick()
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("true")
    expect(select).not.toHaveBeenCalled()
  })

  it("does not re-select a workspace cmux already has selected", async () => {
    cmux.mockResolvedValue(cmuxState(true))
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await tick()
    expect(cmux).toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })

  it("leaves cmux alone for a worktree with no workspace", async () => {
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(C)))
    await tick()
    expect(cmux).toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("true")
  })

  it("never echoes its own navigation back to cmux", async () => {
    wrap(<CmuxFollower />)
    focus(B)
    expect(window.location.pathname).toBe(pageOf(B))
    await tick()
    expect(select).not.toHaveBeenCalled()
  })

  it("ignores a stale focus event for the worktree just left", async () => {
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await waitFor(() => expect(select).toHaveBeenCalled())
    focus(A)
    expect(window.location.pathname).toBe(pageOf(B))
  })

  it("follows again once cmux confirms the switch", async () => {
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await waitFor(() => expect(select).toHaveBeenCalled())
    focus(B)
    focus(A)
    expect(window.location.pathname).toBe(pageOf(A))
  })

  it("follows again after the guard window", async () => {
    let now = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => now)
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await waitFor(() => expect(select).toHaveBeenCalled())
    now += TWO_WAY_GUARD_MS + 1
    focus(A)
    expect(window.location.pathname).toBe(pageOf(A))
  })

  it("a failed switch clears the guard", async () => {
    select.mockResolvedValue({ ok: false, error: "x" })
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await waitFor(() => expect(select).toHaveBeenCalled())
    await tick()
    focus(A)
    expect(window.location.pathname).toBe(pageOf(A))
  })

  it("a rejected switch clears the guard", async () => {
    select.mockRejectedValue(new Error("down"))
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await waitFor(() => expect(select).toHaveBeenCalled())
    await tick()
    focus(A)
    expect(window.location.pathname).toBe(pageOf(A))
  })

  it("fetches cmux state when none is cached", async () => {
    wrap(<CmuxFollower />)
    expect(cmux).not.toHaveBeenCalled()
    act(() => navigate(pageOf(B)))
    await waitFor(() => expect(select).toHaveBeenCalledWith("workspace:2"))
    expect(cmux).toHaveBeenCalled()
  })

  it("does nothing while following is off", async () => {
    act(() => setFollowCmux(false))
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await tick()
    expect(select).not.toHaveBeenCalled()
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

describe("FollowingCmuxBanner", () => {
  it("is hidden while following is off", () => {
    wrap(<FollowingCmuxBanner />)
    expect(screen.queryByRole("button", { name: /stop following/i })).toBeNull()
  })

  it("turns following off from its button", async () => {
    act(() => setFollowCmux(true))
    wrap(<FollowingCmuxBanner />)
    await userEvent.click(screen.getByRole("button", { name: /stop following/i }))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("false")
    expect(screen.queryByRole("button", { name: /stop following/i })).toBeNull()
  })
})
