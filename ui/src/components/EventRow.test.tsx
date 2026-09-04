import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { EventRow } from "./EventRow"
import type { TimelineEvent } from "../api/types"
import { UNREAD_BORDER_WIDTH } from "../lib/unread"
import { DOT_CENTER, DOT_SIZE, ROW_PAD_X } from "./timelineRail"

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
    // The type is carried by the dot alone now (label + tooltip), so assert
    // on its accessible name; eventMeta's human label ("merged") beats
    // echoing the raw wire value ("pr_merged") at the user.
    const e = makeEvent({ type_label: "", type: "pr_merged" })
    renderWithProvider(<EventRow e={e} />)
    // Capitalised for display, unlike the raw mapping value.
    expect(screen.getByLabelText("Merged")).toBeInTheDocument()
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

describe("global timeline affordances", () => {
  const withWorktrees = () => makeEvent({
    resource_type: "pr", resource_id: "o/r#42", resource_title: "PR #42",
    worktrees: ["wt-a", "wt-b"], worktree_paths: ["/wt/a", "/wt/b"],
  })

  it("makes each worktree badge open its own worktree", () => {
    const onSelectWorktree = vi.fn()
    renderWithProvider(
      <EventRow e={withWorktrees()} showWorktrees onSelectWorktree={onSelectWorktree} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /open worktree wt-b/i }))
    // Paired by index with `worktrees`, so the second badge is the second path.
    expect(onSelectWorktree).toHaveBeenCalledWith("/wt/b")
  })

  it("leaves badges as plain text when the event carries no paths", () => {
    const e = makeEvent({ worktrees: ["wt-a"], worktree_paths: undefined })
    renderWithProvider(<EventRow e={e} showWorktrees onSelectWorktree={vi.fn()} />)
    // The badge is prefixed so a worktree name is identifiable as one at a
    // glance on the global timeline, where badges sit beside resource chips.
    expect(screen.getByText("Worktree: wt-a")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /open worktree/i })).not.toBeInTheDocument()
  })

  it("hides the resource chip when the event has nowhere to go, but still names it", () => {
    renderWithProvider(
      <EventRow e={withWorktrees()} onSelectResource={vi.fn()} canSelectResource={() => false} />,
    )
    expect(screen.queryByRole("button", { name: /select resource/i })).not.toBeInTheDocument()
    expect(screen.getByText("PR #42")).toBeInTheDocument()
  })

  it("keeps the badges outside the details button, never nested inside it", () => {
    // A button inside a button is invalid markup with an ambiguous target.
    const { container } = renderWithProvider(
      <EventRow e={withWorktrees()} showWorktrees onOpen={vi.fn()} onSelectWorktree={vi.fn()} />,
    )
    const badge = screen.getByRole("button", { name: /open worktree wt-a/i })
    expect(badge.closest("button") === badge).toBe(true)
    expect(container.querySelectorAll("button button")).toHaveLength(0)
  })

  it("marks an unread event", () => {
    renderWithProvider(<EventRow e={makeEvent({ unread: true })} />)
    expect(screen.getByLabelText("unread event")).toBeInTheDocument()
  })

  it("does not mark a read event", () => {
    renderWithProvider(<EventRow e={makeEvent({ unread: false })} />)
    expect(screen.queryByLabelText("unread event")).not.toBeInTheDocument()
  })
})

describe("unread event highlight", () => {
  const UNREAD_BORDER = "2px solid var(--mantine-color-blue-5)"
  const READ_BORDER = "2px solid transparent"
  const BG = "color-mix(in srgb, var(--mantine-color-blue-filled) 10%, transparent)"
  const row = (c: HTMLElement) => c.querySelector("[data-event-row]") as HTMLElement

  it("boxes an unread event", () => {
    const { container } = renderWithProvider(<EventRow e={makeEvent({ unread: true, title: "New review" })} />)
    expect(row(container)).toHaveStyle({ border: UNREAD_BORDER, background: BG })
  })

  it("leaves a read event unboxed", () => {
    const { container } = renderWithProvider(<EventRow e={makeEvent({ unread: false, title: "Old review" })} />)
    expect(container.querySelector("[data-unread]")).toBeNull()
  })

  it("reserves the border on every row so unread gains colour, not width", () => {
    // A border that appears only when unread would shift the row's text and
    // make the feed look ragged.
    const { container } = renderWithProvider(<EventRow e={makeEvent({ unread: false })} />)
    expect(row(container)).toHaveStyle({ border: READ_BORDER })
  })

  it("clears the box completely when the event is marked read", () => {
    // Regression: the border was once a shorthand plus a conditional
    // borderColor. Clearing the colour dropped the shorthand from the CSSOM,
    // leaving width and style behind with border-color falling back to
    // currentColor — a white box that survived until the page was reloaded.
    const { container, rerender } = renderWithProvider(<EventRow e={makeEvent({ unread: true })} />)
    expect(row(container)).toHaveStyle({ border: UNREAD_BORDER })

    rerender(<MantineProvider><EventRow e={makeEvent({ unread: false })} /></MantineProvider>)
    const after = row(container)
    expect(after).toHaveStyle({ border: READ_BORDER })
    expect(after.style.borderColor).toBe("transparent")
    expect(after.style.background).toBe("")
  })
})

describe("rail alignment", () => {
  it("reserves exactly the border width the rail offsets the line by", () => {
    // The rail line and the dots are drawn by different components. If a row's
    // actual border stops matching UNREAD_BORDER_WIDTH, every dot shifts and
    // the line runs down their edge — which is what happened when the unread
    // box was first added. Parsed from the DOM, not from the constant, so
    // changing the border string without the width fails here.
    const { container } = renderWithProvider(<EventRow e={makeEvent({ unread: false })} />)
    const row = container.querySelector("[data-event-row]") as HTMLElement
    const width = parseInt(row.style.border, 10)
    expect(width).toBe(UNREAD_BORDER_WIDTH)
    expect(DOT_CENTER).toBe(UNREAD_BORDER_WIDTH + ROW_PAD_X + DOT_SIZE / 2)
  })
})
