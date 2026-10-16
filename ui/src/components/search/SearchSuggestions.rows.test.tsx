import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { AllResourceDTO, TimelineEvent, WorktreeSummary } from "../../api/types"
import { SearchSuggestions } from "./SearchSuggestions"
import type { Suggestion } from "./SearchBar"

const wt: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "foo-branch", on_disk: true, resource_count: 0, primary_count: 0,
  latest_event_ts: "", primary_by_type: {}, related_count: 0, focus_resources: [],
}
const res: AllResourceDTO = {
  type: "jira", id: "RHOAIENG-7", url: "u", primary: true, title: "Migrate the proxy", status: "In Progress",
  assignee: "Pat", worktrees: [{ path: "/wt/foo", repo: "odh", branch: "foo-branch" }],
}
const archived: TimelineEvent = {
  id: "e1", ts: "2026-10-01T00:00:00Z", external_ts: "", source: "github", type: "pr_comment", type_label: "Comment",
  title: "Old remark", body: "", author: "someone", resource_type: "pr", resource_id: "o/r#2",
  resource_url: "https://gh/pr/2", resource_title: "Gone PR", worktrees: [], worktree_paths: [],
}
const items: Suggestion[] = [
  { key: "w", group: "Worktrees", label: wt.branch, onPick: () => {}, item: { kind: "worktree", w: wt } },
  { key: "r", group: "Resources", label: "Migrate the proxy", onPick: () => {}, item: { kind: "resource", r: res } },
  { key: "e", group: "Activity", label: "Old remark", onPick: () => {}, item: { kind: "event", e: archived } },
]

beforeEach(() => {
  vi.spyOn(api, "cmux").mockResolvedValue({
    available: true,
    matches: { "/wt/foo": [{ ref: "workspace:1", title: "Persimmon workspace", color: "#ff0000", selected: false }] },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const wrap = () =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <SearchSuggestions items={items} active={-1} onHover={() => {}} onPick={() => {}} />
      </QueryClientProvider>
    </MantineProvider>,
  )

describe("dropdown rows", () => {
  it("shows a worktree under its cmux workspace, as the cards do", async () => {
    wrap()
    const row = screen.getAllByRole("option")[0]
    expect(await within(row).findByText("Persimmon workspace")).toBeInTheDocument()
    expect(within(row).getByText("foo")).toBeInTheDocument()
    expect(within(row).getByText("odh · foo-branch")).toBeInTheDocument()
  })

  it("renders a resource with its type/key/status line above its title", () => {
    wrap()
    const row = screen.getAllByRole("option")[1]
    expect(within(row).getByText("RHOAIENG-7")).toBeInTheDocument()
    expect(within(row).getByText("Migrate the proxy")).toBeInTheDocument()
    const key = within(row).getByText("RHOAIENG-7")
    const title = within(row).getByText("Migrate the proxy")
    expect(key.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("renders an event as the activity list does, archived label included", () => {
    wrap()
    const row = screen.getAllByRole("option")[2]
    expect(within(row).getByText("Old remark")).toBeInTheDocument()
    expect(within(row).getByText("Archived")).toBeInTheDocument()
  })

  it("puts no buttons or links inside an option", () => {
    wrap()
    for (const row of screen.getAllByRole("option")) {
      expect(within(row).queryAllByRole("button")).toHaveLength(0)
      expect(within(row).queryAllByRole("link")).toHaveLength(0)
    }
  })

  it("explains that the page filters too, above the results", () => {
    wrap()
    const hint = screen.getByText("The page is also filtered as you type. Press Enter to view all results.")
    expect(hint.compareDocumentPosition(screen.getAllByRole("option")[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("heads each section with its count", () => {
    wrap()
    const headings = screen.getAllByTestId("suggestion-group").map((h) => h.textContent)
    expect(headings).toEqual(["Worktrees1", "Resources1", "Activity1"])
  })
})
