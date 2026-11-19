import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { HomeWorktreeBanner } from "./HomeWorktreeBanner"
import { captureHomeWorktree } from "../lib/homeWorktree"
import { usePublishEscLeaves } from "../lib/escapeHint"

const WT = "/Users/me/.worktrees/repo/my-branch"
const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <HomeWorktreeBanner />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

/** Homes the tab the way the server does, then lands on `path`. */
function homedAt(path: string) {
  const sep = path.includes("?") ? "&" : "?"
  window.history.replaceState({}, "", `${path}${sep}home=${encodeURIComponent(WT)}`)
  captureHomeWorktree()
}

const backHome = { name: /back to current worktree/i }

beforeEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  window.history.replaceState({}, "", "/")
})
afterEach(cleanup)

describe("HomeWorktreeBanner", () => {
  it("offers the way back from the listing page", () => {
    homedAt("/")
    wrap()
    expect(screen.getByRole("button", { name: /back to current worktree: my-branch/i }))
      .toBeInTheDocument()
  })

  it("offers it from another worktree's page too", () => {
    homedAt("/worktree/%2Fsomewhere%2Felse")
    wrap()
    expect(screen.getByRole("button", backHome)).toBeInTheDocument()
  })

  it("stays out of the way on the home worktree's own page", () => {
    homedAt(`/worktree/${encodeURIComponent(WT)}`)
    wrap()
    expect(screen.queryByRole("button", backHome)).toBeNull()
  })

  it("renders nothing at all in a tab nobody homed", () => {
    // Most tabs. The banner must not appear just because you opened the UI.
    window.history.replaceState({}, "", "/")
    wrap()
    expect(screen.queryByRole("button", backHome)).toBeNull()
  })

  it("navigates to the home worktree when clicked", async () => {
    homedAt("/")
    wrap()
    await userEvent.click(screen.getByRole("button", backHome))
    expect(decodeURIComponent(window.location.pathname)).toBe(`/worktree/${WT}`)
  })

  it("keeps the home in the URL after navigating, so a restore survives", () => {
    // A cmux pane that sleeps and comes back has only its URL. If a
    // navigation drops the parameter, the restored pane forgets its worktree.
    homedAt("/")
    wrap()
    expect(new URLSearchParams(window.location.search).get("home")).toBe(WT)
  })
})

describe("HomeWorktreeBanner dismissal", () => {
  it("hides the home banner for the rest of the tab", async () => {
    homedAt("/")
    const { unmount } = wrap()
    await userEvent.click(screen.getByRole("button", { name: /don't show this/i }))
    expect(screen.queryByRole("button", backHome)).toBeNull()

    // And it stays gone across a re-render, which is what a navigation is.
    unmount()
    wrap()
    expect(screen.queryByRole("button", backHome)).toBeNull()
  })
})

describe("HomeWorktreeBanner Esc hint", () => {
  function Leaving() {
    usePublishEscLeaves(true)
    return null
  }

  it("shows Esc only while the page says Esc leaves it", async () => {
    homedAt("/")
    const view = wrap()
    expect((await screen.findByRole("button", backHome)).querySelector("kbd")).toBeNull()
    view.unmount()

    homedAt("/")
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MantineProvider>
        <QueryClientProvider client={qc}>
          <Leaving />
          <HomeWorktreeBanner />
        </QueryClientProvider>
      </MantineProvider>,
    )
    expect((await screen.findByRole("button", backHome)).querySelector("kbd")?.textContent).toBe("Esc")
  })
})
