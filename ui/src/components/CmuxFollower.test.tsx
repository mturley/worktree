import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { CmuxFollower, worktreeAt } from "./CmuxFollower"
import { FollowCmuxToggle } from "./FollowCmuxToggle"
import { emitCmuxFocus } from "../lib/cmuxFocusBus"
import { setFollowCmux, FOLLOW_CMUX_KEY } from "../hooks/useFollowCmux"
import { useUnsavedChanges } from "../lib/unsavedChanges"
import { api } from "../api/client"

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
    expect(screen.queryByRole("switch", { name: /follow cmux focus/i })).toBeNull()
  })

  it("persists to sessionStorage when turned on", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    wrap(<FollowCmuxToggle />)
    await userEvent.click(await screen.findByRole("switch", { name: /follow cmux focus/i }))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("true")
  })
})
