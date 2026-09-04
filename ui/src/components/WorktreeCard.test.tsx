import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { WorktreeCard } from "./WorktreeCard"
import { api } from "../api/client"

const summary: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "my-branch",
  on_disk: true, resource_count: 2, primary_count: 2, latest_event_ts: "",
  primary_by_type: { pr: 1, jira: 1 }, related_count: 0,
  focus_resources: [
    { type: "pr", id: "o/r#1", url: "https://github.com/o/r/pull/1", primary: true, title: "Fix the widget", state: "OPEN" },
    { type: "jira", id: "J-1", url: "https://jira/browse/J-1", primary: true, title: "Investigate flux", status: "In Progress" },
  ],
}

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => window.history.replaceState({}, "", "/"))
afterEach(cleanup)

describe("WorktreeCard", () => {
  it("shows the worktree name as the heading, with branch and repo as meta", () => {
    wrap(<WorktreeCard w={summary} />)
    // The heading is the worktree's own name (last path segment); the branch
    // moved to the dimmed meta line beneath it.
    expect(screen.getByRole("link", { name: /open worktree foo/i })).toBeInTheDocument()
    expect(screen.getByText(/my-branch/)).toBeInTheDocument()
    expect(screen.getByText(/odh/)).toBeInTheDocument()
  })

  it("shows the PR number and Jira key beside each focus resource", () => {
    wrap(<WorktreeCard w={summary} />)
    // Same abbreviation the timeline's event chips use.
    expect(screen.getByText("#1")).toBeInTheDocument()
    expect(screen.getByText("J-1")).toBeInTheDocument()
  })

  it("names each focus resource as plain content, never as its own link", () => {
    wrap(<WorktreeCard w={summary} />)
    // The card is one big target; small per-resource links made it fiddly to
    // hit, and picking a resource is one easy click away on the detail page.
    expect(screen.getByText(/Fix the widget/)).toBeInTheDocument()
    expect(screen.getByText(/Investigate flux/)).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Fix the widget/ })).not.toBeInTheDocument()
    expect(screen.getByLabelText("open")).toBeInTheDocument()
  })

  it("is a single link covering the whole card", () => {
    wrap(<WorktreeCard w={summary} />)
    // Exactly one link: nothing nested inside it to compete for the click.
    const links = screen.getAllByRole("link")
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute("href")).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
  })

  it("navigates to the worktree detail page when the card body is clicked", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} />)
    // Deliberately click a NON-link part of the card: the whole card is the
    // click target, not just the branch name.
    await user.click(screen.getByText(/odh/))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
  })

  it("navigates exactly once when the card is clicked", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} />)
    const before = window.history.length
    await user.click(screen.getByRole("link", { name: /open worktree foo/i }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
    // One anchor, one handler: nothing nested can double-push history.
    expect(window.history.length - before).toBe(1)
  })

  it("navigates when the focused card is activated with the keyboard", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} />)
    // An <a href> is focusable and Enter-activates natively, so the card no
    // longer needs a hand-rolled keydown handler.
    screen.getByRole("link", { name: /open worktree foo/i }).focus()
    await user.keyboard("{Enter}")
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
  })

  it("does not navigate when clickable is false", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} clickable={false} />)
    await user.click(screen.getByText(/my-branch/))
    await user.click(screen.getByText(/odh/))
    expect(window.location.pathname).toBe("/")
  })

  it("flags a worktree that is missing on disk", () => {
    wrap(<WorktreeCard w={{ ...summary, on_disk: false }} />)
    expect(screen.getByText("missing")).toBeInTheDocument()
  })

  it("renders without resource lines when there are no focus resources", () => {
    wrap(<WorktreeCard w={{ ...summary, focus_resources: [], primary_by_type: {}, primary_count: 0, resource_count: 0 }} />)
    // The heading is the worktree's own name (last path segment); the branch
    // moved to the dimmed meta line beneath it.
    expect(screen.getByRole("link", { name: /open worktree foo/i })).toBeInTheDocument()
    expect(screen.getByText(/my-branch/)).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Fix the widget/ })).not.toBeInTheDocument()
  })
})

describe("WorktreeCard interactive affordance", () => {
  it("marks a clickable card as interactive so it gets the clickable surface + hover", () => {
    const { container } = wrap(<WorktreeCard w={summary} />)
    expect(container.querySelector('[data-interactive="true"]')).toBeInTheDocument()
  })

  it("does not mark a non-clickable card as interactive", () => {
    const { container } = wrap(<WorktreeCard w={summary} clickable={false} />)
    expect(container.querySelector('[data-interactive="true"]')).not.toBeInTheDocument()
  })
})

describe("focus resource meta lines", () => {
  const card = (r: Partial<ResourceDTO>) =>
    wrap(<WorktreeCard w={{ ...summary, focus_resources: [{ type: "pr", id: "o/r#1", url: "u", primary: true, ...r } as ResourceDTO] }} />)

  it("shows author and updated time under a PR", () => {
    card({ type: "pr", id: "o/r#1", title: "Fix the widget", author: "octocat", updated_at: "2026-08-25T00:00:00Z" })
    expect(screen.getByText(/octocat/)).toBeInTheDocument()
    expect(screen.getByText(/updated/)).toBeInTheDocument()
  })

  it("shows status and priority under a Jira issue", () => {
    card({ type: "jira", id: "J-1", title: "Investigate flux", status: "In Progress", priority: "High", updated_at: "2026-08-25T00:00:00Z" })
    const meta = screen.getByText(/In Progress/)
    expect(meta.textContent).toContain("High")
    expect(meta.textContent).toContain("updated")
  })

  it("shows the root author under a Slack thread", () => {
    card({ type: "slack", id: "C1:1699000000.000100", title: "Deploy thread", author: "ana", updated_ts: "1699000500.000200" })
    expect(screen.getByText(/ana/)).toBeInTheDocument()
  })

  it("reads a Slack thread's time from updated_ts, not updated_at", () => {
    // Slack carries a raw Slack ts; PRs and Jira carry RFC3339. Feeding one
    // to the other's formatter prints the raw string straight back.
    card({ type: "slack", id: "C1:1699000000.000100", title: "Deploy thread", author: "ana", updated_ts: "1699000500.000200" })
    expect(screen.queryByText(/1699000500/)).not.toBeInTheDocument()
    expect(screen.getByText(/ana ·/)).toBeInTheDocument()
  })

  it("omits the line entirely for a resource that has never been polled", () => {
    card({ type: "pr", id: "o/r#9" })
    expect(screen.queryByText(/updated/)).not.toBeInTheDocument()
  })
})


describe("WorktreeCard card surface", () => {
  it("puts the hover affordance on the whole card, not just the inner content", () => {
    // Regression guard. When the cmux section was added it had to move out of
    // the card's anchor, and the affordance flag went with it — so the lighter
    // background and hover lit only the lower half of the card, with the cmux
    // strip left on the plain body colour. The card is one surface: the flag
    // belongs to the outermost element, and the anchor keeps only the focus
    // ring (data-card-link).
    const { container } = wrap(<WorktreeCard w={summary} />)

    const card = container.querySelector('[data-interactive="true"]')
    expect(card).not.toBeNull()

    const link = screen.getByRole("link", { name: /open worktree foo/i })
    // The flagged element must CONTAIN the link, never be it.
    expect(card).not.toBe(link)
    expect(card!.contains(link)).toBe(true)

    // And the cmux section, which sits outside the anchor, must still be
    // inside the flagged element — otherwise it misses the hover again.
    expect(card!.querySelector("[data-cmux-section]")).toBe(
      container.querySelector("[data-cmux-section]"),
    )
  })

  it("keeps a focus ring hook on the anchor itself", () => {
    // The ring belongs to the thing that takes focus, which is the link, not
    // the card. cards.css matches on this attribute.
    wrap(<WorktreeCard w={summary} />)
    expect(screen.getByRole("link", { name: /open worktree foo/i }))
      .toHaveAttribute("data-card-link", "true")
  })

  it("carries no affordance flag when not clickable", () => {
    const { container } = wrap(<WorktreeCard w={summary} clickable={false} />)
    expect(container.querySelector('[data-interactive="true"]')).toBeNull()
    expect(container.querySelector('[data-card-link="true"]')).toBeNull()
  })
})

describe("WorktreeCard title demotion inside cmux", () => {
  afterEach(() => vi.restoreAllMocks())

  it("keeps the worktree name as the heading when there is no cmux workspace", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    wrap(<WorktreeCard w={summary} />)
    const title = await screen.findByText("foo")
    expect(getComputedStyle(title).fontWeight).toBe("700")
  })

  it("steps the worktree name down when a workspace is the headline", async () => {
    // The workspace name becomes the card's heading, so two bold headings
    // would compete. The worktree name becomes the subtitle instead.
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/foo": [{ ref: "workspace:1", title: "my workspace", selected: false }] },
    })
    wrap(<WorktreeCard w={summary} />)
    await screen.findByText("my workspace")
    const title = screen.getByText("foo")
    expect(getComputedStyle(title).fontWeight).toBe("600")
  })
})

describe("WorktreeCard meta line", () => {
  it("shows repo and branch only — no counts, no worktree timestamp", () => {
    // The counts restated the resource list directly below, and the
    // worktree-level timestamp restated the per-resource "updated" on each
    // row. Identity is the only thing this line still carries.
    wrap(<WorktreeCard w={{ ...summary, latest_event_ts: "2026-08-31T10:00:00Z" }} />)

    expect(screen.getByText(/^odh · my-branch$/)).toBeInTheDocument()
    // No "1 PR, 1 issue" style roll-up anywhere on the card.
    expect(screen.queryByText(/\d+ PR/)).toBeNull()
    // And no worktree-level relative time. The per-resource rows keep theirs,
    // so match the standalone form rather than any "ago" on the card.
    expect(screen.queryByText(/^\d+\w* ago$/)).toBeNull()
  })
})

describe("WorktreeCard related resources", () => {
  it("names related resources by type, not just a total", () => {
    // Related resources are deliberately not listed individually, so this
    // line is the only place their shape shows. "2 related Slack threads"
    // tells you where to look; "2 related resources" does not.
    wrap(<WorktreeCard w={{ ...summary, related_count: 3, related_by_type: { slack: 2, jira: 1 } }} />)
    // Ordered by the shared TYPE_ORDER (pr, jira, slack) so this line reads
    // in the same sequence as the primary counts elsewhere, regardless of
    // the order the map happens to arrive in.
    expect(screen.getByText("+ 1 related Jira issue, 2 related Slack threads")).toBeInTheDocument()
  })

  it("uses the singular for exactly one of a type", () => {
    wrap(<WorktreeCard w={{ ...summary, related_count: 1, related_by_type: { slack: 1 } }} />)
    expect(screen.getByText("+ 1 related Slack thread")).toBeInTheDocument()
  })

  it("says nothing when there are none", () => {
    wrap(<WorktreeCard w={{ ...summary, related_count: 0, related_by_type: {} }} />)
    expect(screen.queryByText(/related/)).toBeNull()
  })

  it("says nothing when an older cached response omits the breakdown", () => {
    // related_by_type is absent on a response cached before the field existed.
    // Better to show no line than to render "+ undefined".
    wrap(<WorktreeCard w={{ ...summary, related_count: 2, related_by_type: undefined }} />)
    expect(screen.queryByText(/related/)).toBeNull()
  })
})

describe("WorktreeCard WT badge", () => {
  it("labels the worktree name with a WORKTREE badge", () => {
    // The badge keeps the worktree's own name identifiable once the cmux
    // workspace name takes over as the card's headline.
    wrap(<WorktreeCard w={summary} />)
    expect(screen.getByText("WORKTREE")).toBeInTheDocument()
  })
})

describe("WorktreeCard unread dot", () => {
  it("shows an unread dot on a focus resource with unread events", () => {
    wrap(<WorktreeCard w={{
      ...summary,
      focus_resources: [
        { type: "pr", id: "o/r#1", url: "u", primary: true, title: "Fix the widget", state: "OPEN", unread_count: 2 } as ResourceDTO,
      ],
    }} />)
    expect(screen.getByLabelText("unread")).toBeInTheDocument()
  })

  it("shows no unread dot when every focus resource is read", () => {
    wrap(<WorktreeCard w={{
      ...summary,
      focus_resources: [
        { type: "pr", id: "o/r#1", url: "u", primary: true, title: "Fix the widget", state: "OPEN" } as ResourceDTO,
      ],
    }} />)
    expect(screen.queryByLabelText("unread")).not.toBeInTheDocument()
  })
})

describe("unread accent", () => {
  const ACCENT = "3px solid var(--mantine-color-blue-5)"
  // The Paper wraps the link; the accent lives on it so it spans the cmux
  // strip too, which sits above the link.
  const card = () => screen.getByRole("link", { name: /open worktree foo/i }).closest(".mantine-Paper-root")

  it("marks a worktree whose resources have unread activity", () => {
    wrap(<WorktreeCard w={{ ...summary, has_unread: true }} />)
    expect(card()).toHaveStyle({ borderLeft: ACCENT })
  })

  it("leaves a fully read worktree unmarked", () => {
    wrap(<WorktreeCard w={{ ...summary, has_unread: false }} />)
    expect(card()).not.toHaveStyle({ borderLeft: ACCENT })
  })

  it("reads the server's aggregate, not the focus resources", () => {
    // Related resources are counted but never listed, so the flag has to come
    // from the server. A card with unread related resources and fully read
    // focus ones must still be marked.
    wrap(<WorktreeCard w={{ ...summary, has_unread: true, focus_resources: [] }} />)
    expect(card()).toHaveStyle({ borderLeft: ACCENT })
  })
})
