import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useSelectedResource } from "./useSelectedResource"

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
    window.history.replaceState({}, "", "/worktree/wt?tab=overview")
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "select pr" }))
    expect(window.location.search).toContain("tab=overview")
  })
})
