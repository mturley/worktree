import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

  it("names the resource as read-only text, never as a second button", () => {
    // The row itself is the button now, so a chip button inside it would be
    // invalid markup with an ambiguous click target.
    const e = makeEvent({ resource_title: "PR #42", resource_type: "pr", resource_id: "o/r#42" })
    const { container } = renderWithProvider(
      <EventRow e={e} onOpen={vi.fn()} onSelectResource={vi.fn()} />,
    )
    expect(container.querySelectorAll("button")).toHaveLength(1)
    // The PR number is pulled out of the composite id for a readable ref.
    expect(screen.getByText("#42")).toBeInTheDocument()
  })

  it("never nests a link inside the clickable row", () => {
    // The row is a <button>, so the resource link moved into the details
    // modal: a link inside a button is invalid markup and makes a click
    // ambiguous between navigating and activating the row.
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

  it("draws worktree badges as read-only labels", () => {
    const { container } = renderWithProvider(
      <EventRow e={withWorktrees()} showWorktrees onOpen={vi.fn()} />,
    )
    // The badge is prefixed so a worktree name is identifiable as one at a
    // glance on the global timeline, where badges sit beside resource chips.
    expect(screen.getByText("Worktree: wt-a")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /open worktree/i })).not.toBeInTheDocument()
    // The row is the only button: nothing inside it competes for the click.
    expect(container.querySelectorAll("button")).toHaveLength(1)
  })

  it("draws worktree badges in the same light blue as the worktree cards", () => {
    // Same thing named in two places should look the same in both.
    renderWithProvider(<EventRow e={withWorktrees()} showWorktrees />)
    // getByText lands on the label span; the variant and colour live on the
    // Badge root above it.
    const badge = screen.getByText("Worktree: wt-a").closest("[data-variant]") as HTMLElement
    expect(badge).toHaveAttribute("data-variant", "light")
    expect(badge.style.getPropertyValue("--badge-bg")).toContain("blue")
  })

  it("still names the resource when the event has nowhere to go", () => {
    renderWithProvider(
      <EventRow e={withWorktrees()} onOpen={vi.fn()} onSelectResource={vi.fn()} canSelectResource={() => false} />,
    )
    expect(screen.getByText("PR #42")).toBeInTheDocument()
  })

  it("nests no button inside the row's button", () => {
    // A button inside a button is invalid markup with an ambiguous target.
    const { container } = renderWithProvider(
      <EventRow e={withWorktrees()} showWorktrees onOpen={vi.fn()} onSelectResource={vi.fn()} />,
    )
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
    // One complete background value per state, for the same reason as the
    // border: a cleared background would let the <button> element's own
    // default surface show through.
    expect(after.style.background).toBe("transparent")
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

describe("where a click on the row goes", () => {
  const e = () => makeEvent({ resource_type: "pr", resource_id: "o/r#42", title: "Add feature X" })

  it("opens the resource when the feed can select one", () => {
    // The whole row, not a chip inside it: the entry is one target.
    const onSelectResource = vi.fn()
    const onOpen = vi.fn()
    renderWithProvider(<EventRow e={e()} onOpen={onOpen} onSelectResource={onSelectResource} />)
    fireEvent.click(screen.getByRole("button"))
    expect(onSelectResource).toHaveBeenCalledWith({ type: "pr", id: "o/r#42" })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("opens the details when the feed has no resource selection to make", () => {
    // This is the resource detail pane: the resource is ALREADY selected, so
    // selecting it again would do nothing and the details are what is left.
    const onOpen = vi.fn()
    renderWithProvider(<EventRow e={e()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole("button"))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "evt-1" }))
  })

  it("falls back to the details when the resource has nowhere to go", () => {
    // A global-timeline event whose resource no longer belongs to any
    // worktree cannot be routed to one, but its details still read fine.
    const onOpen = vi.fn()
    const onSelectResource = vi.fn()
    renderWithProvider(
      <EventRow e={e()} onOpen={onOpen} onSelectResource={onSelectResource} canSelectResource={() => false} />,
    )
    fireEvent.click(screen.getByRole("button"))
    expect(onSelectResource).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalled()
  })

  it("falls back to the details for an event that names no resource", () => {
    const onOpen = vi.fn()
    const onSelectResource = vi.fn()
    renderWithProvider(
      <EventRow
        e={makeEvent({ resource_type: "", resource_id: "" })}
        onOpen={onOpen}
        onSelectResource={onSelectResource}
      />,
    )
    fireEvent.click(screen.getByRole("button"))
    expect(onSelectResource).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalled()
  })

  it("marks a clickable row so the stylesheet can give it a hover", () => {
    const { container } = renderWithProvider(<EventRow e={e()} onOpen={vi.fn()} />)
    expect(container.querySelector("[data-event-row]")).toHaveAttribute("data-clickable", "true")
  })

  it("leaves an inert row unmarked, so it does not look clickable", () => {
    const { container } = renderWithProvider(<EventRow e={e()} />)
    expect(container.querySelector("[data-event-row]")).not.toHaveAttribute("data-clickable")
  })
})

describe("CI event bodies", () => {
  // A CI body is the whole check list ("✓ Unit-Tests" × 130). Clamped to two
  // lines it is a meaningless fragment beside a title that already says
  // "CI failed … (2 failed, 35 passed)". The modal still shows it in full.
  const checks = "✗ Setup: FAILURE\n✓ detect-dirs\n✓ Unit-Tests"

  it("omits the clamped body preview for a CI event", () => {
    const { container } = renderWithProvider(
      <EventRow e={makeEvent({ type: "ci_failed", body: checks })} />,
    )
    expect(container.textContent).not.toContain("detect-dirs")
  })

  it("omits it for every ci_ variant, including the workflow ones", () => {
    const { container } = renderWithProvider(
      <EventRow e={makeEvent({ type: "ci_workflows_partial_failure", body: checks })} />,
    )
    expect(container.textContent).not.toContain("detect-dirs")
  })

  it("keeps the preview for a comment, where the body is the point", () => {
    const { container } = renderWithProvider(
      <EventRow e={makeEvent({ type: "pr_comment", body: "please rebase" })} />,
    )
    expect(container.textContent).toContain("please rebase")
  })
})

describe("the row's tooltip names its destination", () => {
  // The two destinations look identical until you click, so the row says
  // which one it is before you do. Mantine only mounts the floating content
  // once the target is actually hovered.
  const hoverRow = async (ui: React.ReactElement) => {
    renderWithProvider(ui)
    await userEvent.hover(screen.getByRole("button"))
  }

  it('says "View resource in worktree" for a row that opens its resource', async () => {
    await hoverRow(<EventRow e={makeEvent({ resource_type: "pr", resource_id: "o/r#42" })} onSelectResource={vi.fn()} />)
    expect(await screen.findByText("View resource in worktree")).toBeInTheDocument()
  })

  it('says "View event details" for a row that opens the modal', async () => {
    await hoverRow(<EventRow e={makeEvent({})} onOpen={vi.fn()} />)
    expect(await screen.findByText("View event details")).toBeInTheDocument()
  })
})

describe("the context lines below the event", () => {
  it("puts the worktree badges on a line of their own, below the resource", () => {
    // A resource title can be long enough that a badge trailing it lands
    // anywhere, and the worktree is what you scan the global feed by.
    const { container } = renderWithProvider(
      <EventRow
        e={makeEvent({ resource_type: "pr", resource_id: "o/r#42", resource_title: "PR #42", worktrees: ["wt-a"] })}
        showWorktrees
      />,
    )
    const badge = screen.getByText("Worktree: wt-a")
    const chip = screen.getByText("PR #42")
    // Different parents means different flex lines, not two items wrapping.
    expect(badge.closest("[data-event-row] > * > *")).not.toBe(chip.closest("[data-event-row] > * > *"))
    expect(container.querySelectorAll("button")).toHaveLength(0)
  })

  it("draws no worktree line at all when there are no worktrees", () => {
    renderWithProvider(<EventRow e={makeEvent({ worktrees: [] })} showWorktrees />)
    expect(screen.queryByText(/^Worktree:/)).toBeNull()
  })
})

describe("the resource label is unboxed", () => {
  it("carries no border, now that it is not a button", () => {
    const { container } = renderWithProvider(
      <EventRow e={makeEvent({ resource_type: "pr", resource_id: "o/r#42", resource_title: "PR #42" })} />,
    )
    expect(container.textContent).toContain("PR #42")
    // The row's own box is the only border in the entry; nothing inside it
    // draws a second one competing with it.
    const boxed = [...container.querySelectorAll<HTMLElement>("[data-event-row] *")]
      .filter((el) => el.style.border || el.style.borderWidth)
    expect(boxed).toHaveLength(0)
  })
})
