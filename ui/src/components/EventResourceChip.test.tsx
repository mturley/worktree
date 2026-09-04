import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { EventResourceChip } from "./EventResourceChip"
import type { ResourceDTO, TimelineEvent } from "../api/types"

const ev = (o: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: "e1", ts: "2026-08-26T00:00:00Z", external_ts: "", source: "github",
  type: "pr_comment", type_label: "PR comments", title: "t", body: "", author: "",
  resource_type: "pr", resource_id: "o/r#42", resource_url: "u",
  resource_title: "Fix the widget", worktrees: [], ...o,
})

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(cleanup)

describe("EventResourceChip enrichment", () => {
  it("uses the event's own enriched resource when no resolver is supplied", () => {
    // The global timeline has no per-worktree resource list, so without this
    // the chip fell back to a bare shape and rendered a generic grey icon.
    const e = ev({
      resource: { type: "pr", id: "o/r#42", url: "u", primary: true, state: "MERGED", title: "Fix the widget" } as ResourceDTO,
    })
    wrap(<EventResourceChip e={e} onSelect={vi.fn()} />)
    expect(screen.getByLabelText("merged")).toBeInTheDocument()
  })

  it("prefers a resolver over the embedded copy, which may be staler", () => {
    const e = ev({
      resource: { type: "pr", id: "o/r#42", url: "u", primary: true, state: "OPEN" } as ResourceDTO,
    })
    const fresh = { type: "pr", id: "o/r#42", url: "u", primary: true, state: "MERGED" } as ResourceDTO
    wrap(<EventResourceChip e={e} onSelect={vi.fn()} resolveResource={() => fresh} />)
    expect(screen.getByLabelText("merged")).toBeInTheDocument()
  })

  it("prefers a custom name over the fetched title", () => {
    const e = ev({
      resource: { type: "pr", id: "o/r#42", url: "u", primary: true, title: "Fix the widget", custom_name: "The blocker" } as ResourceDTO,
    })
    wrap(<EventResourceChip e={e} onSelect={vi.fn()} />)
    expect(screen.getByText("The blocker")).toBeInTheDocument()
  })

  it("shows an unread dot when the event's resource has unread activity", () => {
    const e = ev({
      resource: { type: "pr", id: "o/r#42", url: "u", primary: true, state: "OPEN", unread_count: 1 } as ResourceDTO,
    })
    wrap(<EventResourceChip e={e} onSelect={vi.fn()} />)
    expect(screen.getByLabelText("unread")).toBeInTheDocument()
  })

  it("shows no unread dot for a read resource", () => {
    const e = ev({
      resource: { type: "pr", id: "o/r#42", url: "u", primary: true, state: "OPEN" } as ResourceDTO,
    })
    wrap(<EventResourceChip e={e} onSelect={vi.fn()} />)
    expect(screen.queryByLabelText("unread")).not.toBeInTheDocument()
  })
})
