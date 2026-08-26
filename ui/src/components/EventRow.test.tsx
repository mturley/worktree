import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { EventRow } from "./EventRow"
import type { TimelineEvent } from "../api/types"

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>)
}

function makeEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    id: "evt-1",
    ts: "2026-08-18T00:00:00Z",
    external_ts: "",
    source: "github",
    type: "pr_opened",
    type_label: "PR Opened",
    title: "Add feature X",
    body: "",
    author: "",
    resource_type: "pr",
    resource_id: "123",
    resource_url: "",
    resource_title: "",
    worktrees: [],
    ...overrides,
  }
}

describe("EventRow", () => {
  it("shows the title, and keeps the type label reachable on the dot", () => {
    // The rail replaced the text badge with a coloured dot, so the type label
    // now lives as the dot's accessible name rather than as visible text.
    const e = makeEvent({ type_label: "PR Opened", title: "Add feature X" })
    const { container } = renderWithProvider(<EventRow e={e} />)
    expect(container.textContent).toContain("Add feature X")
    expect(screen.getByLabelText("PR Opened")).toBeInTheDocument()
  })

  it("falls back to the mapping's readable label when type_label is empty", () => {
    // eventMeta supplies a human label ("merged"), which beats echoing the
    // raw wire value ("pr_merged") at the user.
    const e = makeEvent({ type_label: "", type: "pr_merged" })
    renderWithProvider(<EventRow e={e} />)
    expect(screen.getByLabelText("merged")).toBeInTheDocument()
    expect(screen.getByText("merged")).toBeInTheDocument()
  })

  it("renders worktree badges when showWorktrees is true and worktrees are present", () => {
    const e = makeEvent({ worktrees: ["feature-a", "feature-b"] })
    const { container } = renderWithProvider(<EventRow e={e} showWorktrees />)
    expect(container.textContent).toContain("feature-a")
    expect(container.textContent).toContain("feature-b")
  })

  it("does not render worktree badges when showWorktrees is false, even if worktrees are present", () => {
    const e = makeEvent({ worktrees: ["feature-a"] })
    const { container } = renderWithProvider(<EventRow e={e} />)
    expect(container.textContent).not.toContain("feature-a")
  })

  it("shows the resource as a chip that selects it, when selection is possible", () => {
    const onSelectResource = vi.fn()
    const e = makeEvent({ resource_title: "PR #42", resource_type: "pr", resource_id: "o/r#42" })
    renderWithProvider(<EventRow e={e} onOpen={vi.fn()} onSelectResource={onSelectResource} />)
    fireEvent.click(screen.getByRole("button", { name: /select resource o\/r#42/i }))
    expect(onSelectResource).toHaveBeenCalledWith({ type: "pr", id: "o/r#42" })
    // The PR number is pulled out of the composite id for a readable ref.
    expect(screen.getByText("#42")).toBeInTheDocument()
  })

  it("never nests a link inside the clickable row", () => {
    // The row is a <button> that opens the details modal, so the resource
    // link moved into that modal: a link inside a button is invalid markup
    // and makes a click ambiguous between navigating and opening details.
    const e = makeEvent({ resource_title: "PR #42", resource_url: "https://github.com/org/repo/pull/42" })
    const { container } = renderWithProvider(<EventRow e={e} onOpen={vi.fn()} />)
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("PR #42")
  })

  it("opens the details modal when the row is clicked", () => {
    const onOpen = vi.fn()
    const e = makeEvent({ title: "Add feature X" })
    renderWithProvider(<EventRow e={e} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole("button"))
    expect(onOpen).toHaveBeenCalledWith(e)
  })

  it("is not a button when no handler is supplied, so it cannot look clickable", () => {
    const e = makeEvent({})
    renderWithProvider(<EventRow e={e} />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("renders the resource_title as plain text when resource_url is empty", () => {
    const e = makeEvent({ resource_title: "PR #42", resource_url: "" })
    const { container } = renderWithProvider(<EventRow e={e} />)
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("PR #42")
  })
})
