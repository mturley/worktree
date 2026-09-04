import { beforeEach, describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Link, Route, Router, Switch, useLocation } from "wouter"
import { useHomeLocation } from "./useHomeLocation"
import { captureHomeWorktree } from "./homeWorktree"

const WT = "/Users/me/.worktrees/repo/my-branch"
const home = () => new URLSearchParams(window.location.search).get("home")

function Harness() {
  const [location, navigate] = useLocation()
  return (
    <Router hook={useHomeLocation}>
      <div data-testid="loc">{location}</div>
      <button onClick={() => navigate("/worktree/other")}>go</button>
      <Link href="/">home link</Link>
      <Switch>
        <Route path="/" >listing</Route>
        <Route path="/worktree/:rest*">detail</Route>
      </Switch>
    </Router>
  )
}

/** The whole harness must sit inside the Router to use its hook. */
function App() {
  return (
    <Router hook={useHomeLocation}>
      <Harness />
    </Router>
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState({}, "", `/?home=${encodeURIComponent(WT)}`)
  captureHomeWorktree()
})

describe("useHomeLocation", () => {
  it("keeps the home parameter across a programmatic navigation", async () => {
    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "go" }))
    expect(window.location.pathname).toBe("/worktree/other")
    expect(home()).toBe(WT)
  })

  it("keeps it across a <Link> click, which routes through the same hook", async () => {
    window.history.replaceState({}, "", `/worktree/x?home=${encodeURIComponent(WT)}`)
    render(<App />)
    await userEvent.click(screen.getByRole("link", { name: "home link" }))
    expect(window.location.pathname).toBe("/")
    expect(home()).toBe(WT)
  })

  it("reports a bare pathname, so the parameter cannot break route matching", async () => {
    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "go" }))
    expect(screen.getByTestId("loc").textContent).toBe("/worktree/other")
    expect(screen.getByText("detail")).toBeInTheDocument()
  })

  it("adds nothing in a tab with no home", async () => {
    window.sessionStorage.clear()
    window.history.replaceState({}, "", "/")
    render(<App />)
    await userEvent.click(screen.getByRole("button", { name: "go" }))
    expect(window.location.search).toBe("")
  })
})
