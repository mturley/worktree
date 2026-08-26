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

  it("links out to the resource", () => {
    wrap(<EventDetailsModal e={ev()} onClose={vi.fn()} />)
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("https://gh/pr/1")
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

describe("resource chip in the modal", () => {
  it("selects the resource and closes, so the result is not hidden behind the modal", async () => {
    const onSelectResource = vi.fn()
    const onClose = vi.fn()
    wrap(
      <EventDetailsModal
        e={ev({ resource_type: "pr", resource_id: "o/r#42" })}
        onClose={onClose}
        onSelectResource={onSelectResource}
      />,
    )
    fireEvent.click(await screen.findByRole("button", { name: /select resource o\/r#42/i }))
    expect(onSelectResource).toHaveBeenCalledWith({ type: "pr", id: "o/r#42" })
    expect(onClose).toHaveBeenCalled()
  })

  it("names the resource as plain text when selection is not possible", () => {
    wrap(<EventDetailsModal e={ev()} onClose={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /select resource/i })).not.toBeInTheDocument()
    expect(screen.getByText("Fix the widget PR")).toBeInTheDocument()
  })
})

