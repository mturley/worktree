import { afterEach, describe, it, expect, vi } from "vitest"
import userEvent from "@testing-library/user-event"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { EventDetailsModal } from "./EventDetailsModal"
import { TimelineFeed } from "./TimelineFeed"
import type { CmuxResponse, ResourceDTO, TimelineEvent, WorktreeSummary } from "../api/types"

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

// The open button looks for a cmux tab already showing the resource, so the
// modal needs a QueryClient.
const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
    </MantineProvider>,
  )

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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

  it("Make task closes this modal first, then makes the task", async () => {
    const calls: string[] = []
    const onClose = vi.fn(() => calls.push("close"))
    const onMakeTask = vi.fn(() => calls.push("make"))
    const e = ev({ id: "0b7e3c1a-5d2f-4a8b-9c6e-1f2a3b4c5d6e" })
    wrap(<EventDetailsModal e={e} onClose={onClose} onMakeTask={onMakeTask} />)
    await userEvent.click(screen.getByRole("button", { name: "Make task" }))
    expect(onMakeTask).toHaveBeenCalledWith(e)
    expect(calls).toEqual(["close", "make"])
  })

  it("offers Make task only when asked to, and only for a watcher event", () => {
    const { rerender } = wrap(<EventDetailsModal e={ev({ id: "0b7e3c1a-5d2f-4a8b-9c6e-1f2a3b4c5d6e" })} onClose={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Make task" })).toBeNull()
    rerender(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <EventDetailsModal e={ev({ id: "task:1" })} onClose={vi.fn()} onMakeTask={vi.fn()} />
        </QueryClientProvider>
      </MantineProvider>,
    )
    expect(screen.queryByRole("button", { name: "Make task" })).toBeNull()
  })

  it("links out to the resource, naming the destination", () => {
    // "Open" alone did not say where it went; matches the resource card's
    // button wording.
    wrap(<EventDetailsModal e={ev()} onClose={vi.fn()} />)
    expect(screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("href")).toBe("https://gh/pr/1")
  })

  it("uses the resource card's controls, including switching to an open cmux tab", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, workspaces: [], matches: {} } as unknown as CmuxResponse)
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({
      available: true,
      tabs: [{ workspaceId: "w-UUID", workspaceRef: "workspace:w", workspaceTitle: "w", workspaceSelected: false, pane: "pane:1", surface: "surface:w", url: "https://github.com/o/r/pull/1" }],
    })
    wrap(<EventDetailsModal e={ev({ resource_url: "https://github.com/o/r/pull/1" })} onClose={vi.fn()} />)
    expect(await screen.findByRole("button", { name: "Switch to open GitHub tab" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument()
  })

  it("still links out when the event's embedded resource carries no url", async () => {
    // The server enriches an event's resource from cached state, which has no
    // URL; only the event row does. Feeds with no resolver — a selected
    // resource's own feed, the home page — get just that embedded copy.
    const resource = { type: "pr", id: "o/r#1", url: "", primary: false, title: "Fix the widget PR", state: "OPEN" } as ResourceDTO
    wrap(<EventDetailsModal e={ev({ resource })} onClose={vi.fn()} />)
    expect((await screen.findByRole("link", { name: "Open on GitHub" })).getAttribute("href")).toBe("https://gh/pr/1")
  })

  it("introduces the resource with its brand badge and typed key", async () => {
    const resource = { type: "jira", id: "J-1", url: "https://jira/J-1", primary: true, issue_type: "Bug", title: "Flux" } as ResourceDTO
    wrap(
      <EventDetailsModal
        e={ev({ resource_type: "jira", resource_id: "J-1", resource_url: "https://jira/J-1", resource })}
        onClose={vi.fn()}
      />,
    )
    expect(await screen.findByText("Jira")).toBeInTheDocument()
    expect(screen.getByText("Bug J-1")).toBeInTheDocument()
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
    await screen.findByText("Worktree: wt-a")
    expect(screen.getByText("Worktree: wt-b")).toBeInTheDocument()
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

describe("EventDetailsModal for an archived resource", () => {
  const worktrees = [
    { path: "/wt/zeta", repo: "r", branch: "zeta" },
    { path: "/wt/alpha", repo: "r", branch: "alpha" },
  ] as unknown as WorktreeSummary[]
  const cmux = {
    available: true, workspaces: [],
    matches: { "/wt/zeta": [{ ref: "workspace:1", title: "Zeta work", color: "#ff0000" }] },
  } as unknown as CmuxResponse

  it("says nothing follows it, and offers worktrees with their cmux workspaces", async () => {
    vi.spyOn(api, "worktrees").mockResolvedValue(worktrees)
    vi.spyOn(api, "cmux").mockResolvedValue(cmux)
    wrap(<EventDetailsModal e={ev({ worktree_paths: [] })} onClose={vi.fn()} />)
    expect(screen.getByText("This resource is no longer followed by a worktree.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Follow" }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["alpha", "Zeta workzeta"])
  })

  it("routes to the chosen worktree carrying the URL and custom name", async () => {
    vi.spyOn(api, "worktrees").mockResolvedValue(worktrees)
    vi.spyOn(api, "cmux").mockResolvedValue(cmux)
    const onClose = vi.fn()
    const e = ev({
      resource_type: "slack", resource_id: "C1:1.2", resource_url: "https://x.slack.com/archives/C1/p12",
      resource: { type: "slack", id: "C1:1.2", url: "", primary: false, custom_name: "Deploy", custom_description: "Why" } as ResourceDTO,
    })
    wrap(<EventDetailsModal e={e} onClose={onClose} />)
    await userEvent.click(screen.getByRole("button", { name: "Follow" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: /alpha/ }))
    expect(onClose).toHaveBeenCalled()
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/alpha")}`)
    expect(window.history.state).toEqual({
      followResource: { url: "https://x.slack.com/archives/C1/p12", name: "Deploy", description: "Why" },
    })
    window.history.replaceState(null, "", "/")
  })

  it("has no alert while a worktree still follows the resource", () => {
    wrap(<EventDetailsModal e={ev({ worktrees: ["b"], worktree_paths: ["/wt/b"] })} onClose={vi.fn()} />)
    expect(screen.queryByText("This resource is no longer followed by a worktree.")).toBeNull()
  })
})
