import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from "vitest"
import { act, render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider, Modal } from "@mantine/core"
import { useState } from "react"
import { CmuxFollower, TWO_WAY_GUARD_MS, worktreeAt } from "./CmuxFollower"
import { FollowCmuxToggle } from "./FollowCmuxToggle"
import { FollowingCmuxBanner } from "./FollowingCmuxBanner"
import { emitCmuxFocus } from "../lib/cmuxFocusBus"
import { setFollowCmux, FOLLOW_CMUX_KEY } from "../hooks/useFollowCmux"
import { isCmuxTwoWaySync, setCmuxTwoWaySync } from "../hooks/useCmuxTwoWaySync"
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

  it("does not count its own prompt as an open modal", async () => {
    act(() => setFollowCmux(true))
    wrap(<><CmuxFollower /><Dirty /></>)
    focus(B)
    await screen.findByRole("button", { name: /discard and follow/i })
    focus("/wt/repo/c")
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(screen.queryByRole("button", { name: "Close modal and follow" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /discard and follow/i }))
    expect(window.location.pathname).toBe(pageOf("/wt/repo/c"))
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

  /** A promise and its resolver, to hold a request open. */
  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
  }
  const D = "/wt/repo/d"
  const wide = {
    available: true,
    matches: {
      [A]: [{ ref: "workspace:1", title: "a", selected: true }],
      [B]: [{ ref: "workspace:2", title: "b", selected: false }],
      [C]: [{ ref: "workspace:3", title: "c", selected: false }],
      [D]: [{ ref: "workspace:4", title: "d", selected: false }],
    },
  }

  it("guards against stale events while it is still looking up the workspace", async () => {
    const lookup = deferred<typeof wide>()
    cmux.mockReturnValue(lookup.promise)
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    focus(A)
    expect(window.location.pathname).toBe(pageOf(B))
    await act(async () => { lookup.resolve(wide) })
    await waitFor(() => expect(select).toHaveBeenCalledWith("workspace:2"))
  })

  it("skips a switch for a worktree the user has already left", async () => {
    const lookup = deferred<typeof wide>()
    cmux.mockReturnValue(lookup.promise)
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    act(() => navigate(pageOf(C)))
    await act(async () => { lookup.resolve(wide) })
    await waitFor(() => expect(select).toHaveBeenCalledWith("workspace:3"))
    expect(select).not.toHaveBeenCalledWith("workspace:2")
  })

  it("sends one switch at a time, and only the latest of those queued", async () => {
    cmux.mockResolvedValue(wide)
    const first = deferred<{ ok: boolean }>()
    select.mockReturnValueOnce(first.promise)
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await waitFor(() => expect(select).toHaveBeenCalledWith("workspace:2"))
    act(() => navigate(pageOf(C)))
    act(() => navigate(pageOf(D)))
    await tick()
    expect(select).toHaveBeenCalledTimes(1)
    await act(async () => { first.resolve({ ok: true }) })
    await waitFor(() => expect(select).toHaveBeenCalledWith("workspace:4"))
    expect(select).not.toHaveBeenCalledWith("workspace:3")
    // cmux's late report of B must not pull the tab back from D.
    focus(B)
    expect(window.location.pathname).toBe(pageOf(D))
  })

  it("does nothing while following is off", async () => {
    act(() => setFollowCmux(false))
    wrap(<CmuxFollower />)
    act(() => navigate(pageOf(B)))
    await tick()
    expect(select).not.toHaveBeenCalled()
  })
})

describe("CmuxFollower with a modal open", () => {
  const C = "/wt/repo/c"

  /** A modal the test can close, as the user would. */
  function Dialog({ name = "dialog", children }: { name?: string; children?: React.ReactNode }) {
    const [opened, setOpened] = useState(true)
    return (
      <Modal opened={opened} onClose={() => setOpened(false)} title={name} transitionProps={{ duration: 0 }}>
        <button onClick={() => setOpened(false)}>close {name}</button>
        {children}
      </Modal>
    )
  }
  const closeDialog = (name = "dialog") => userEvent.click(screen.getByRole("button", { name: `close ${name}` }))
  const prompt = {
    close: { name: "Close modal and follow" },
    stop: { name: "Stop following" },
    later: { name: "Follow after modal closes" },
  }

  beforeEach(() => act(() => setFollowCmux(true)))

  it("asks rather than leaving an open modal", async () => {
    wrap(<><CmuxFollower /><Dialog /></>)
    focus(B)
    expect(window.location.pathname).toBe(pageOf(A))
    expect(await screen.findByRole("button", prompt.close)).toBeInTheDocument()
    expect(screen.getByRole("button", prompt.stop)).toBeInTheDocument()
    expect(screen.getByRole("button", prompt.later)).toBeInTheDocument()
  })

  it("Close modal and follow follows", async () => {
    wrap(<><CmuxFollower /><Dialog /></>)
    focus(B)
    await userEvent.click(await screen.findByRole("button", prompt.close))
    expect(window.location.pathname).toBe(pageOf(B))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("true")
  })

  it("Stop following stays and turns following off", async () => {
    wrap(<><CmuxFollower /><Dialog /></>)
    focus(B)
    await userEvent.click(await screen.findByRole("button", prompt.stop))
    expect(window.location.pathname).toBe(pageOf(A))
    expect(window.sessionStorage.getItem(FOLLOW_CMUX_KEY)).toBe("false")
  })

  it("Follow after modal closes waits for the modal to close", async () => {
    wrap(<><CmuxFollower /><Dialog /></>)
    focus(B)
    await userEvent.click(await screen.findByRole("button", prompt.later))
    expect(screen.queryByRole("button", prompt.later)).toBeNull()
    expect(window.location.pathname).toBe(pageOf(A))
    await closeDialog()
    await waitFor(() => expect(window.location.pathname).toBe(pageOf(B)))
  })

  it("waits for nested modals until none is open", async () => {
    wrap(<><CmuxFollower /><Dialog name="outer"><Dialog name="inner" /></Dialog></>)
    focus(B)
    await userEvent.click(await screen.findByRole("button", prompt.later))
    await closeDialog("inner")
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(window.location.pathname).toBe(pageOf(A))
    await closeDialog("outer")
    await waitFor(() => expect(window.location.pathname).toBe(pageOf(B)))
  })

  it("a later cmux switch replaces the queued one without asking again", async () => {
    wrap(<><CmuxFollower /><Dialog /></>)
    focus(B)
    await userEvent.click(await screen.findByRole("button", prompt.later))
    focus(C)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(screen.queryByRole("button", prompt.later)).toBeNull()
    await closeDialog()
    await waitFor(() => expect(window.location.pathname).toBe(pageOf(C)))
  })

  it("a second switch while asking updates the prompt's target", async () => {
    wrap(<><CmuxFollower /><Dialog /></>)
    focus(B)
    await screen.findByRole("button", prompt.close)
    focus(C)
    await userEvent.click(screen.getByRole("button", prompt.close))
    expect(window.location.pathname).toBe(pageOf(C))
  })

  it("drops the queued switch when the user navigates", async () => {
    act(() => setCmuxTwoWaySync(true))
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    wrap(<><CmuxFollower /><Dialog /></>)
    focus(B)
    await userEvent.click(await screen.findByRole("button", prompt.later))
    act(() => navigate(pageOf(C)))
    await closeDialog()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(window.location.pathname).toBe(pageOf(C))
  })

  it("drops the queued switch when following is turned off", async () => {
    wrap(<><CmuxFollower /><Dialog /></>)
    focus(B)
    await userEvent.click(await screen.findByRole("button", prompt.later))
    act(() => setFollowCmux(false))
    await closeDialog()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(window.location.pathname).toBe(pageOf(A))
  })

  it("says closing discards the modal's unsaved changes", async () => {
    wrap(<><CmuxFollower /><Dialog><Dirty /></Dialog></>)
    focus(B)
    expect(await screen.findByText(/unsaved changes will be lost/i)).toBeInTheDocument()
  })

  it("does not mention unsaved changes when there are none", async () => {
    wrap(<><CmuxFollower /><Dialog /></>)
    focus(B)
    await screen.findByRole("button", prompt.close)
    expect(screen.queryByText(/unsaved changes will be lost/i)).toBeNull()
  })

  it("asks about unsaved edits again when a queued switch lands on a dirty page", async () => {
    wrap(<><CmuxFollower /><Dialog /><Dirty /></>)
    focus(B)
    await userEvent.click(await screen.findByRole("button", prompt.later))
    await closeDialog()
    expect(await screen.findByRole("button", { name: /discard and follow/i })).toBeInTheDocument()
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

  it("offers two-way sync, off by default", () => {
    act(() => setFollowCmux(true))
    wrap(<FollowingCmuxBanner />)
    expect(screen.getByRole("switch", { name: "Two-way sync" })).not.toBeChecked()
    expect(screen.getByText(/^Following cmux:/)).toBeInTheDocument()
  })

  it("turning it on persists and changes the text", async () => {
    act(() => setFollowCmux(true))
    wrap(<FollowingCmuxBanner />)
    await userEvent.click(screen.getByRole("switch", { name: "Two-way sync" }))
    expect(window.sessionStorage.getItem("worktree.cmuxTwoWaySync")).toBe("true")
    expect(screen.getByText(
      /^Synced with cmux: switching workspaces there opens their worktrees here, and opening a worktree here switches cmux to it\.$/,
    )).toBeInTheDocument()
  })

  it("stop following keeps the two-way choice", async () => {
    act(() => setFollowCmux(true))
    act(() => setCmuxTwoWaySync(true))
    wrap(<FollowingCmuxBanner />)
    await userEvent.click(screen.getByRole("button", { name: /stop following/i }))
    expect(screen.queryByRole("switch", { name: "Two-way sync" })).toBeNull()
    expect(isCmuxTwoWaySync()).toBe(true)
  })
})
