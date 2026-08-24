import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { WorktreeSummary } from "../api/types"
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
  it("shows the branch and repo", () => {
    wrap(<WorktreeCard w={summary} />)
    expect(screen.getByText("my-branch")).toBeInTheDocument()
    expect(screen.getByText(/odh/)).toBeInTheDocument()
  })

  it("renders one line per focus resource with its title and link", () => {
    wrap(<WorktreeCard w={summary} />)
    const pr = screen.getByRole("link", { name: /Fix the widget/ })
    // Focus lines deep link into the worktree with the resource selected,
    // rather than out to GitHub/Jira/Slack.
    expect(pr.getAttribute("href")).toContain(`/worktree/${encodeURIComponent("/wt/foo")}`)
    expect(pr.getAttribute("href")).toContain("resource=pr:")
    expect(screen.getByRole("link", { name: /Investigate flux/ })).toBeInTheDocument()
    expect(screen.getByLabelText("open")).toBeInTheDocument()
  })

  it("navigates to the worktree detail page when the card body is clicked", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} />)
    // Deliberately click a NON-link part of the card: the whole card is the
    // click target, not just the branch name.
    await user.click(screen.getByText(/odh/))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
  })

  it("navigates when the branch link is activated", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} />)
    const before = window.history.length
    await user.click(screen.getByRole("link", { name: /open worktree my-branch/i }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
    // The branch anchor's onClick calls stopPropagation() before navigating
    // itself, so the card's own onClick (which would also navigate) must not
    // ALSO fire. If it did, history would grow by 2 pushes instead of 1.
    expect(window.history.length - before).toBe(1)
  })

  it("navigates when the focused card is activated with the keyboard", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} />)
    screen.getByRole("group", { name: /worktree my-branch/i }).focus()
    await user.keyboard("{Enter}")
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
  })

  it("opens the worktree with that resource pre-selected", async () => {
    // A focus-resource line no longer jumps to GitHub/Jira/Slack: it deep
    // links into the worktree page with the resource already selected, so a
    // mis-click lands somewhere useful instead of a new browser tab.
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} />)
    await user.click(screen.getByRole("link", { name: /Fix the widget/ }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
    // Raw colon here (hand-built href) vs %3A when written via
    // URLSearchParams; both decode to the same key.
    expect(window.location.search).toContain("resource=pr:")
  })

  it("does not navigate when clickable is false", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} clickable={false} />)
    await user.click(screen.getByText("my-branch"))
    await user.click(screen.getByText(/odh/))
    expect(window.location.pathname).toBe("/")
  })

  it("flags a worktree that is missing on disk", () => {
    wrap(<WorktreeCard w={{ ...summary, on_disk: false }} />)
    expect(screen.getByText("missing")).toBeInTheDocument()
  })

  it("renders without resource lines when there are no focus resources", () => {
    wrap(<WorktreeCard w={{ ...summary, focus_resources: [], primary_by_type: {}, primary_count: 0, resource_count: 0 }} />)
    expect(screen.getByText("my-branch")).toBeInTheDocument()
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
