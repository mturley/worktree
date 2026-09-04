import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { HomeWorktreeBanner } from "./HomeWorktreeBanner"
import { captureHomeWorktree } from "../lib/homeWorktree"

const WT = "/Users/me/.worktrees/repo/my-branch"
const wrap = () => render(<MantineProvider><HomeWorktreeBanner /></MantineProvider>)

/** Homes the tab the way the server does, then lands on `path`. */
function homedAt(path: string) {
  const sep = path.includes("?") ? "&" : "?"
  window.history.replaceState({}, "", `${path}${sep}home=${encodeURIComponent(WT)}`)
  captureHomeWorktree()
}

beforeEach(() => {
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
    expect(screen.getByRole("button", { name: /back to current worktree/i })).toBeInTheDocument()
  })

  it("stays out of the way on the home worktree's own page", () => {
    homedAt(`/worktree/${encodeURIComponent(WT)}`)
    wrap()
    expect(screen.queryByRole("button", { name: /back to current worktree/i })).toBeNull()
  })

  it("renders nothing at all in a tab nobody homed", () => {
    // Most tabs. The banner must not appear just because you opened the UI.
    window.history.replaceState({}, "", "/")
    wrap()
    expect(screen.queryByRole("button", { name: /back to current worktree/i })).toBeNull()
  })

  it("navigates to the home worktree when clicked", async () => {
    homedAt("/")
    wrap()
    await userEvent.click(screen.getByRole("button", { name: /back to current worktree/i }))
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
