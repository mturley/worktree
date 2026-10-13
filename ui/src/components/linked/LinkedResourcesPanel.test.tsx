import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { LinkedResourcesDTO } from "../../api/types"
import { LinkedResourcesPanel, LinkedTabControls, linkedTabLabel } from "./LinkedResourcesPanel"

type Q = Parameters<typeof LinkedResourcesPanel>[0]["query"]
const q = (over: Partial<Q>): Q => ({ data: undefined, isLoading: false, error: null, refresh: vi.fn(), refreshing: false, refreshError: null, refetch: vi.fn(), ...over })
const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
    </MantineProvider>,
  )

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const dto: LinkedResourcesDTO = {
  fetched_at: "2026-10-09T12:00:00Z",
  count: 4,
  sections: [
    { kind: "description", title: "Linked in description", items: [
      { type: "pr", id: "example/repo#2", url: "https://github.com/example/repo/pull/2", resolved: true, title: "Fix thing", state: "OPEN" },
      { type: "jira", id: "GONE-1", url: "https://example.atlassian.net/browse/GONE-1", resolved: false },
    ] },
    { kind: "links", title: "Linked work items", groups: [
      { label: "is blocked by", items: [{ type: "jira", id: "PROJ-3", url: "u3", resolved: true, title: "Blocker", status: "New", issue_type: "Bug" }] },
    ] },
    { kind: "hierarchy", title: "Hierarchy", tree: [
      { type: "jira", id: "PROJ-10", url: "u10", resolved: true, title: "Epic", issue_type: "Epic", expanded: true, has_children: true, children: [
        { type: "jira", id: "PROJ-1", url: "u1", resolved: true, title: "Me", issue_type: "Story", current: true, expanded: true, has_children: false },
        { type: "jira", id: "PROJ-7", url: "u7", resolved: true, title: "Sibling", issue_type: "Story", expanded: false, has_children: null },
      ] },
    ] },
    { kind: "git_pr", title: "Pull request", items: [] },
    { kind: "thread", title: "Linked in thread", error: "boom" },
  ],
}

describe("LinkedResourcesPanel", () => {
  it("renders sections, groups, unresolved items and section errors; hides empty sections", () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    wrap(<LinkedResourcesPanel query={q({ data: dto })} />)
    expect(screen.getByText("Linked in description")).toBeInTheDocument()
    expect(screen.getByText("Fix thing")).toBeInTheDocument()
    expect(screen.getByText("example/repo#2")).toBeInTheDocument()
    expect(screen.getByText("couldn't load details")).toBeInTheDocument()
    expect(screen.getByText("is blocked by")).toBeInTheDocument()
    expect(screen.getByText("Bug PROJ-3")).toBeInTheDocument()
    expect(screen.queryByText("Pull request")).not.toBeInTheDocument()
    expect(screen.getByText("boom")).toBeInTheDocument()
    expect(screen.getByText("this issue")).toBeInTheDocument()
  })

  it("opens on the path to the current issue, folding the other children of each ancestor", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    wrap(<LinkedResourcesPanel query={q({ data: dto })} />)
    expect(screen.getByText("Me")).toBeInTheDocument()
    expect(screen.queryByText("Sibling")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Show more children of PROJ-10…" }))
    expect(screen.getByText("Sibling")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Show more children/ })).not.toBeInTheDocument()
  })

  it("lazily loads a collapsed node's children", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    const kids = vi.spyOn(api, "linkedChildren").mockResolvedValue({
      items: [{ type: "jira", id: "PROJ-70", url: "u70", resolved: true, title: "Grandkid", expanded: false, has_children: null }],
      more: { url: "https://example.atlassian.net/issues/?jql=x" },
    })
    wrap(<LinkedResourcesPanel query={q({ data: dto })} />)
    expect(screen.queryByText("Grandkid")).not.toBeInTheDocument()
    // Folded away, PROJ-7 isn't shown, so nothing is fetched for it yet.
    expect(kids).not.toHaveBeenCalledWith("PROJ-7")
    await userEvent.click(screen.getByRole("button", { name: "Show more children of PROJ-10…" }))
    // Shown → its children are fetched up front, before any expand.
    await waitFor(() => expect(kids).toHaveBeenCalledWith("PROJ-7"))
    await userEvent.click(await screen.findByRole("button", { name: "Expand PROJ-7" }))
    expect(await screen.findByText("Grandkid")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "More on Jira…" })).toBeInTheDocument()
  })

  it("gives no chevron to a node whose children turn out to be none", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    const kids = vi.spyOn(api, "linkedChildren").mockResolvedValue({ items: [], more: null })
    wrap(<LinkedResourcesPanel query={q({ data: dto })} />)
    await userEvent.click(screen.getByRole("button", { name: "Show more children of PROJ-10…" }))
    await waitFor(() => expect(kids).toHaveBeenCalledWith("PROJ-7"))
    expect(screen.getByText("Sibling")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Expand PROJ-7" })).not.toBeInTheDocument()
  })

  it("makes each section a collapsible accordion item, open to start", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    wrap(<LinkedResourcesPanel query={q({ data: dto })} />)
    const toggle = screen.getByRole("button", { name: "Linked in description" })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("button", { name: "Hierarchy" })).toHaveAttribute("aria-expanded", "true")
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("button", { name: "Hierarchy" })).toHaveAttribute("aria-expanded", "true")
  })

  it("puts an ancestor's fold row above the child on the path", () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    wrap(<LinkedResourcesPanel query={q({ data: dto })} />)
    const fold = screen.getByRole("button", { name: "Show more children of PROJ-10…" })
    const me = screen.getByText("Me")
    expect(fold.compareDocumentPosition(me) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("empty, loading and error states", async () => {
    wrap(<LinkedResourcesPanel query={q({ data: { fetched_at: "", count: 0, sections: [{ kind: "description", title: "Linked in description", items: [] }] } })} />)
    expect(screen.getByText("No linked resources found")).toBeInTheDocument()
    cleanup()
    const refetch = vi.fn()
    wrap(<LinkedResourcesPanel query={q({ error: new Error("Jira 500"), refetch })} />)
    expect(screen.getByText(/Jira 500/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(refetch).toHaveBeenCalled()
  })

  it("treats a hierarchy of only the current issue as empty", () => {
    const lone: LinkedResourcesDTO = { fetched_at: "", count: 0, sections: [
      { kind: "hierarchy", title: "Hierarchy", tree: [
        { type: "jira", id: "PROJ-1", url: "u1", resolved: true, title: "Me", current: true, expanded: true, has_children: false },
      ] },
    ] }
    wrap(<LinkedResourcesPanel query={q({ data: lone })} />)
    expect(screen.getByText("No linked resources found")).toBeInTheDocument()
    expect(screen.queryByText("this issue")).not.toBeInTheDocument()
  })

  it("renders a Slack excerpt's mrkdwn and a globe for favicon-less links", () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false } as never)
    const d: LinkedResourcesDTO = { fetched_at: "", count: 2, sections: [
      { kind: "thread", title: "Linked in thread", items: [
        { type: "slack", id: "C0TEST:1.2", url: "https://example.slack.com/archives/C0TEST/p12", resolved: true, excerpt: "see <https://example.com/x|the doc> &amp; more" },
        { type: "link", id: "https://example.com/y", url: "https://example.com/y", resolved: true, domain: "example.com" },
      ] },
    ] }
    wrap(<LinkedResourcesPanel query={q({ data: d })} />)
    expect(screen.getByRole("link", { name: "the doc" })).toHaveAttribute("href", "https://example.com/x")
    expect(screen.getByText(/& more/)).toBeInTheDocument()
    expect(screen.queryByText(/&amp;/)).not.toBeInTheDocument()
    expect(screen.getByLabelText("link")).toBeInTheDocument()
  })

  it("tab-bar controls show the fetched time and refresh bypasses the cache", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    wrap(<LinkedTabControls query={q({ refresh, data: { fetched_at: new Date().toISOString(), count: 0, sections: [] } })} />)
    expect(screen.getByText(/^Fetched /)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Refresh linked resources" }))
    expect(refresh).toHaveBeenCalled()
  })

  it("shows a refresh error beside the refresh control", () => {
    wrap(<LinkedTabControls query={q({ refreshError: new Error("Jira 500") })} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh failed: Jira 500")
  })

  it("tab label carries the count only once loaded", () => {
    expect(linkedTabLabel(undefined)).toBe("Linked Resources")
    expect(linkedTabLabel({ count: 7 })).toBe("Linked Resources (7)")
  })
})
