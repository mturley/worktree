import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { WorktreeCard } from "./WorktreeCard"

const summary: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "my-branch",
  on_disk: true, resource_count: 2, primary_count: 2, latest_event_ts: "",
  primary_by_type: { pr: 1, jira: 1 }, related_count: 0,
  focus_resources: [
    { type: "pr", id: "o/r#1", url: "https://github.com/o/r/pull/1", primary: true, title: "Fix the widget", state: "OPEN" },
    { type: "jira", id: "J-1", url: "https://jira/browse/J-1", primary: true, title: "Investigate flux", status: "In Progress" },
  ],
}

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

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

