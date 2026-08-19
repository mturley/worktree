import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { Router } from "wouter"
import { WorktreeList } from "./WorktreeList"
import type { WorktreeSummary } from "../api/types"

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

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <MantineProvider>
      <Router>{ui}</Router>
    </MantineProvider>,
  )
}

function makeWorktree(overrides: Partial<WorktreeSummary>): WorktreeSummary {
  return {
    path: "/home/user/repo",
    repo: "repo",
    branch: "main",
    on_disk: true,
    resource_count: 0,
    primary_count: 0,
    latest_event_ts: "2026-08-18T00:00:00Z",
    primary_by_type: {},
    related_count: 0,
    ...overrides,
  }
}

describe("WorktreeList", () => {
  it("shows the empty-state message when there are no worktrees", () => {
    const { container } = render(<MantineProvider><WorktreeList items={[]} /></MantineProvider>)
    expect(container.textContent).toContain("No worktrees. Create one with `worktree add`.")
  })

  it("renders both an on-disk worktree and a missing one, with the missing badge only on the offline item", () => {
    const onDisk = makeWorktree({ path: "/home/user/repo-a", branch: "feature-a", on_disk: true })
    const missing = makeWorktree({ path: "/home/user/repo-b", branch: "feature-b", on_disk: false })
    const { container } = renderWithProviders(<WorktreeList items={[onDisk, missing]} />)

    expect(container.textContent).toContain("feature-a")
    expect(container.textContent).toContain("feature-b")

    const badges = Array.from(container.querySelectorAll(".mantine-Badge-root"))
    expect(badges.some((b) => b.textContent === "missing")).toBe(true)
    expect(badges.length).toBe(1)

    const links = Array.from(container.querySelectorAll("a"))
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      expect.arrayContaining([
        `/worktree/${encodeURIComponent("/home/user/repo-a")}`,
        `/worktree/${encodeURIComponent("/home/user/repo-b")}`,
      ]),
    )
  })

  it("includes the resource summary and repo name in the description", () => {
    const wt = makeWorktree({
      path: "/home/user/repo-c",
      branch: "feature-c",
      repo: "my-repo",
      primary_by_type: { pr: 1 },
      related_count: 2,
    })
    const { container } = renderWithProviders(<WorktreeList items={[wt]} />)
    expect(container.textContent).toContain("my-repo · 1 PR · 2 related resources")
  })
})
