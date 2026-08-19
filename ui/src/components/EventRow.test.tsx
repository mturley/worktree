import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
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
  it("renders the type label badge and title", () => {
    const e = makeEvent({ type_label: "PR Opened", title: "Add feature X" })
    const { container } = renderWithProvider(<EventRow e={e} />)
    expect(container.textContent).toContain("PR Opened")
    expect(container.textContent).toContain("Add feature X")
  })

  it("falls back to the raw type when type_label is empty", () => {
    const e = makeEvent({ type_label: "", type: "pr_merged" })
    const { container } = renderWithProvider(<EventRow e={e} />)
    expect(container.textContent).toContain("pr_merged")
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

  it("renders the resource_title as a link to resource_url when both are set", () => {
    const e = makeEvent({ resource_title: "PR #42", resource_url: "https://github.com/org/repo/pull/42" })
    const { container } = renderWithProvider(<EventRow e={e} />)
    const link = container.querySelector("a")
    expect(link).not.toBeNull()
    expect(link?.getAttribute("href")).toBe("https://github.com/org/repo/pull/42")
    expect(link?.textContent).toBe("PR #42")
  })

  it("renders the resource_title as plain text when resource_url is empty", () => {
    const e = makeEvent({ resource_title: "PR #42", resource_url: "" })
    const { container } = renderWithProvider(<EventRow e={e} />)
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("PR #42")
  })
})
