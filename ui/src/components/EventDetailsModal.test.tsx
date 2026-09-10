import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { EventDetailsModal } from "./EventDetailsModal"
import { TimelineFeed } from "./TimelineFeed"
import type { TimelineEvent } from "../api/types"

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const ev = (o: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "e1", ts: "2026-08-25T00:00:00Z", external_ts: "", source: "github",
  type: "pr_comment", type_label: "PR comments", title: "Fix the widget",
  body: "", author: "octocat", resource_type: "pr", resource_id: "o/r#1",
  resource_url: "https://gh/pr/1", resource_title: "Fix the widget PR",
  worktrees: [], ...o,
})

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

afterEach(cleanup)

describe("EventDetailsModal", () => {
  it("shows the body in full, and preserves its line breaks", () => {
    const body = "line one\nline two\n" + "x".repeat(400)
    wrap(<EventDetailsModal e={ev({ body })} onClose={vi.fn()} />)
    // getByText normalises whitespace, so match on the node's raw textContent:
    // the point of the modal is that nothing is truncated.
    const node = screen.getByText((_, el) => el?.textContent === body)
    expect(node).toBeInTheDocument()
    expect(getComputedStyle(node).whiteSpace).toBe("pre-wrap")
  })

  it("links out to the resource, naming the destination", () => {
    // "Open" alone did not say where it went; matches the resource card's
    // button wording.
    wrap(<EventDetailsModal e={ev()} onClose={vi.fn()} />)
    expect(screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe("https://gh/pr/1")
  })

  it("renders nothing when no event is selected", () => {
    wrap(<EventDetailsModal e={null} onClose={vi.fn()} />)
    expect(screen.queryByText("Fix the widget")).not.toBeInTheDocument()
  })
})

describe("TimelineFeed row -> modal wiring", () => {
  it("opens the details modal for the clicked event", async () => {
    // The row renders the body too (clamped by CSS, so still in the DOM);
    // the dialog is what appears on click.
    wrap(<TimelineFeed events={[ev({ body: "the full comment text" })]} loading={false} error={null} />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    // Mantine's Modal mounts through a transition, so wait for it.
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toBeInTheDocument()
    expect(dialog.textContent).toContain("the full comment text")
  })
})

describe("the modal's context row is read-only", () => {
  // The row that opened the modal is itself the way to the resource, so
  // repeating that navigation here only offered a second, redundant path —
  // one that had to close the modal behind itself to be useful.
  it("names the resource without offering a button", async () => {
    wrap(<EventDetailsModal e={ev({ resource_type: "pr", resource_id: "o/r#42" })} onClose={vi.fn()} />)
    await screen.findByText("Fix the widget PR")
    expect(screen.queryByRole("button", { name: /select resource/i })).not.toBeInTheDocument()
  })

  it("names the worktrees without offering buttons", async () => {
    wrap(
      <EventDetailsModal
        e={ev({ worktrees: ["wt-a", "wt-b"], worktree_paths: ["/wt/a", "/wt/b"] })}
        onClose={vi.fn()}
      />,
    )
    await screen.findByText("wt-a")
    expect(screen.getByText("wt-b")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /open worktree/i })).not.toBeInTheDocument()
  })

  it("puts that context ahead of the content, not after it", async () => {
    wrap(
      <EventDetailsModal
        e={ev({ resource_type: "pr", resource_id: "o/r#42", worktrees: ["wt-a"] })}
        onClose={vi.fn()}
      />,
    )
    const chip = await screen.findByText("Fix the widget PR")
    const title = screen.getByText("Fix the widget")
    // You should not have to scroll past a long comment to find out what you
    // are reading about.
    expect(chip.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
