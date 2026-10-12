import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { render, cleanup, screen, act, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useResourceTab, useSelectedResource } from "./useSelectedResource"

function Probe() {
  const { selected, select, clear, toggle } = useSelectedResource()
  return (
    <div>
      <span data-testid="selected">{selected ? `${selected.type}|${selected.id}` : "none"}</span>
      <button onClick={() => select({ type: "pr", id: "org/repo#1" })}>select pr</button>
      <button onClick={() => toggle({ type: "pr", id: "org/repo#1" })}>toggle pr</button>
      <button onClick={() => toggle({ type: "jira", id: "J-1" })}>toggle jira</button>
      <button onClick={() => clear()}>clear</button>
      <button onClick={() => clear({ replace: true })}>clear replace</button>
    </div>
  )
}

beforeEach(() => window.history.replaceState({}, "", "/worktree/wt"))
afterEach(cleanup)

describe("useSelectedResource", () => {
  it("reads the selection from the ?resource= param", () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=slack:C1%3A1700000000.000100")
    render(<Probe />)
    expect(screen.getByTestId("selected")).toHaveTextContent("slack|C1:1700000000.000100")
  })

  it("reports no selection when the param is absent", () => {
    render(<Probe />)
    expect(screen.getByTestId("selected")).toHaveTextContent("none")
  })

  it("reports no selection for a malformed ?resource= value with no separator", () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=noseparator")
    render(<Probe />)
    expect(screen.getByTestId("selected")).toHaveTextContent("none")
  })

  it("writes the selection into the URL on select", async () => {
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "select pr" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("pr|org/repo#1")
    expect(window.location.search).toContain("resource=pr%3Aorg%252Frepo%25231")
  })

  it("removes the param on clear", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=pr:org%2Frepo%231")
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "clear" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("none")
    expect(window.location.search).not.toContain("resource=")
  })

  it("toggle deselects a key that is already selected", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=pr:org%2Frepo%231")
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "toggle pr" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("none")
  })

  it("toggle selects a key when nothing is selected", async () => {
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "toggle pr" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("pr|org/repo#1")
  })

  it("toggle selects a different key when something else is already selected", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=pr:org%2Frepo%231")
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "toggle jira" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("jira|J-1")
  })

  it("clear({ replace: true }) does not grow history length, unlike a plain clear", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=pr:org%2Frepo%231")
    const user = userEvent.setup()
    render(<Probe />)
    const before = window.history.length
    await user.click(screen.getByRole("button", { name: "clear replace" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("none")
    expect(window.history.length).toBe(before)
  })

  it("preserves other query params", async () => {
    window.history.replaceState({}, "", "/worktree/wt?unread=1")
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "select pr" }))
    expect(window.location.search).toContain("unread=1")
  })
})

const TABS = ["activity", "linked"] as const

function TabProbe() {
  const { selected, select } = useSelectedResource()
  const [tab, setTab] = useResourceTab(TABS)
  return (
    <div>
      <span data-testid="selected">{selected ? `${selected.type}|${selected.id}` : "none"}</span>
      <span data-testid="tab">{tab}</span>
      <button onClick={() => select({ type: "jira", id: "A-1" })}>select a</button>
      <button onClick={() => select({ type: "jira", id: "B-2" })}>select b</button>
      <button onClick={() => setTab("linked")}>linked</button>
      <button onClick={() => setTab("activity")}>activity</button>
      <button onClick={() => setTab("linked", { replace: true })}>linked replace</button>
    </div>
  )
}

async function back() {
  await act(async () => {
    window.history.back()
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe("useResourceTab", () => {
  it("defaults to the first tab, and never writes it to the URL", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=jira:A-1")
    const user = userEvent.setup()
    render(<TabProbe />)
    expect(screen.getByTestId("tab")).toHaveTextContent("activity")
    await user.click(screen.getByRole("button", { name: "linked" }))
    expect(window.location.search).toContain("tab=linked")
    await user.click(screen.getByRole("button", { name: "activity" }))
    expect(window.location.search).not.toContain("tab=")
  })

  it("reads an unknown tab as the default", () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=jira:A-1&tab=nope")
    render(<TabProbe />)
    expect(screen.getByTestId("tab")).toHaveTextContent("activity")
  })

  it("tab switches are history steps; a replace switch is not", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=jira:A-1")
    const user = userEvent.setup()
    render(<TabProbe />)
    const before = window.history.length
    await user.click(screen.getByRole("button", { name: "linked" }))
    expect(window.history.length).toBe(before + 1)
    await back()
    await waitFor(() => expect(screen.getByTestId("tab")).toHaveTextContent("activity"))
    await user.click(screen.getByRole("button", { name: "linked replace" }))
    expect(screen.getByTestId("tab")).toHaveTextContent("linked")
    expect(window.history.length).toBe(before + 1)
  })

  it("a new selection starts on its default tab, and back returns to the tab you left", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=jira:A-1")
    const user = userEvent.setup()
    render(<TabProbe />)
    await user.click(screen.getByRole("button", { name: "linked" }))
    await user.click(screen.getByRole("button", { name: "select b" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("jira|B-2")
    expect(screen.getByTestId("tab")).toHaveTextContent("activity")
    expect(window.location.search).not.toContain("tab=")
    await back()
    await waitFor(() => expect(screen.getByTestId("selected")).toHaveTextContent("jira|A-1"))
    expect(screen.getByTestId("tab")).toHaveTextContent("linked")
  })
})
