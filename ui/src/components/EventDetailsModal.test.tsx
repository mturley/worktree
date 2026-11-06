import { afterEach, describe, it, expect, vi } from "vitest"
import userEvent from "@testing-library/user-event"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { Notifications, notifications } from "@mantine/notifications"
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
  notifications.clean()
  cleanup()
  vi.restoreAllMocks()
})

describe("EventDetailsModal", () => {
  it("doesn't offer the full UI when already in it", () => {
    wrap(<EventDetailsModal e={ev({})} onClose={vi.fn()} />)
    expect(screen.queryByRole("button", { name: /Open in full UI/ })).not.toBeInTheDocument()
  })

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
    const button = screen.getByRole("button", { name: "Make task" })
    // Lime, like the tasks view.
    expect(button.style.getPropertyValue("--button-bg")).toBe("var(--task-accent)")
    await userEvent.click(button)
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

describe("the modal's context row", () => {
  // The row that opened the modal is itself the way to the resource, so
  // repeating that navigation here only offered a second, redundant path —
  // one that had to close the modal behind itself to be useful.
  it("names the resource without offering a button", async () => {
    wrap(<EventDetailsModal e={ev({ resource_type: "pr", resource_id: "o/r#42" })} onClose={vi.fn()} />)
    await screen.findByText("Fix the widget PR")
    expect(screen.queryByRole("button", { name: /select resource/i })).not.toBeInTheDocument()
  })

  it("a worktree chip closes the modal and opens that worktree's page", async () => {
    window.history.pushState({}, "", "/")
    const onClose = vi.fn()
    wrap(
      <EventDetailsModal
        e={ev({ worktrees: ["branch-a", "branch-b"], worktree_paths: ["/wt/wt-a", "/wt/wt-b"] })}
        onClose={onClose}
      />,
    )
    expect(await screen.findByRole("button", { name: "Open worktree wt-a" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Open worktree wt-b" }))
    expect(onClose).toHaveBeenCalled()
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/wt-b")}`)
    expect(window.location.search).toBe("")
  })

  it("a worktree known only by name is a label, with nowhere to go", async () => {
    wrap(<EventDetailsModal e={ev({ worktrees: ["branch-a"] })} onClose={vi.fn()} />)
    await screen.findByText("branch-a")
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
    expect(items.map((i) => i.textContent)).toEqual(["⎇alpha", "Zeta work⎇zeta"])
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

describe("EventDetailsModal go to comment", () => {
  const rc = () => ev({ type: "pr_review_comment" })

  it("jumps to the comment in the diff view and closes", async () => {
    vi.spyOn(api, "locatePRComment").mockResolvedValue({ path: "/w/a", comment_id: 11 })
    const onClose = vi.fn()
    wrap(<EventDetailsModal e={rc()} onClose={onClose} path="/w/b" />)
    await userEvent.click(await screen.findByRole("button", { name: "Go to comment in diff view" }))
    expect(api.locatePRComment).toHaveBeenCalledWith("e1", "/w/b")
    expect(onClose).toHaveBeenCalled()
    expect(window.location.pathname).toBe("/worktree/%2Fw%2Fa")
    expect(window.location.search).toBe("?diff&prcomment=11")
  })

  it("has no button when the comment cannot be located", async () => {
    const spy = vi.spyOn(api, "locatePRComment").mockRejectedValue(new Error("404"))
    wrap(<EventDetailsModal e={rc()} onClose={vi.fn()} />)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole("button", { name: "Go to comment in diff view" })).toBeNull()
  })

  it("never locates other event types", async () => {
    const spy = vi.spyOn(api, "locatePRComment").mockResolvedValue({ path: "/w/a", comment_id: 11 })
    wrap(<EventDetailsModal e={ev()} onClose={vi.fn()} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(spy).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Go to comment in diff view" })).toBeNull()
  })
})

describe("EventDetailsModal unread", () => {
  const wrapWithToasts = (ui: React.ReactNode) =>
    render(
      <MantineProvider>
        <Notifications />
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
      </MantineProvider>,
    )
  const content = () => document.querySelector<HTMLElement>(".mantine-Modal-content")!
  const markButton = () => screen.queryByRole("button", { name: "Mark read" })
  const outlined = () => content().style.border.includes("blue")

  it("outlines an unread event's modal, and only an unread one's", () => {
    const { unmount } = wrapWithToasts(<EventDetailsModal e={ev({ unread: true })} onClose={vi.fn()} />)
    expect(outlined()).toBe(true)
    unmount()
    wrapWithToasts(<EventDetailsModal e={ev({ unread: false })} onClose={vi.fn()} />)
    expect(outlined()).toBe(false)
    // The same width either way, so clearing it shifts nothing. A border and
    // not an outline: the sticky header paints over anything inside the box.
    expect(content().style.border).toContain("2px solid")
    expect(content().style.outline).toBe("")
    expect(markButton()).toBeNull()
  })

  it("offers Mark read in the blue of Mark all read", () => {
    wrapWithToasts(<EventDetailsModal e={ev({ unread: true })} onClose={vi.fn()} />)
    expect(markButton()!.style.getPropertyValue("--button-bg")).toBe("var(--mantine-color-blue-filled)")
    expect(markButton()!.style.getPropertyValue("--button-hover")).toBe("var(--mantine-color-blue-4)")
  })

  it("outlines an unread Slack event but offers no Mark read", () => {
    wrapWithToasts(<EventDetailsModal e={ev({ unread: true, source: "slack", resource_type: "slack" })} onClose={vi.fn()} />)
    expect(outlined()).toBe(true)
    expect(markButton()).toBeNull()
  })

  it("marks read in place, and Undo brings the outline and the button back", async () => {
    const mark = vi.spyOn(api, "markEventRead").mockResolvedValue({ id: "e1", ts: "2026-08-25T00:00:00Z", previous: "", changed: true })
    const restore = vi.spyOn(api, "restoreEventRead").mockResolvedValue(null)
    const onClose = vi.fn()
    wrapWithToasts(<EventDetailsModal e={ev({ unread: true })} onClose={onClose} />)

    await userEvent.click(markButton()!)
    expect(mark).toHaveBeenCalledWith({ id: "e1", ts: "2026-08-25T00:00:00Z" })
    expect(onClose).not.toHaveBeenCalled()
    expect(outlined()).toBe(false)
    expect(markButton()).toBeNull()

    expect(await screen.findByText("Marked read: Fix the widget")).toBeInTheDocument()
    await userEvent.click(await screen.findByRole("button", { name: /^Undo/ }))
    expect(restore).toHaveBeenCalledWith({ id: "e1", ts: "2026-08-25T00:00:00Z", previous: "" })
    expect(await screen.findByRole("button", { name: "Mark read" })).toBeInTheDocument()
    expect(outlined()).toBe(true)
  })

  const unreadButton = () => screen.queryByRole("button", { name: "Mark unread" })
  const followed = { worktrees: ["a"], worktree_paths: ["/wt/a"] }

  it("marks a read event unread in place, and Undo takes it back", async () => {
    const mark = vi.spyOn(api, "markEventUnread").mockResolvedValue({ id: "e1", ts: "2026-08-25T00:00:00Z", previous: "read", changed: true })
    const restore = vi.spyOn(api, "restoreEventRead").mockResolvedValue(null)
    wrapWithToasts(<EventDetailsModal e={ev({ unread: false, can_mark_unread: true, ...followed })} onClose={vi.fn()} />)
    expect(outlined()).toBe(false)

    await userEvent.click(unreadButton()!)
    expect(mark).toHaveBeenCalledWith({ id: "e1", ts: "2026-08-25T00:00:00Z" })
    expect(outlined()).toBe(true)
    expect(unreadButton()).toBeNull()
    expect(markButton()).toBeInTheDocument()
    expect(await screen.findByText("Marked unread: Fix the widget")).toBeInTheDocument()

    await userEvent.click(await screen.findByRole("button", { name: /^Undo/ }))
    expect(restore).toHaveBeenCalledWith({ id: "e1", ts: "2026-08-25T00:00:00Z", previous: "read" })
    expect(await screen.findByRole("button", { name: "Mark unread" })).toBeInTheDocument()
    expect(outlined()).toBe(false)
  })

  it("offers Mark unread straight after Mark read", async () => {
    vi.spyOn(api, "markEventRead").mockResolvedValue({ id: "e1", ts: "2026-08-25T00:00:00Z", previous: "", changed: true })
    wrapWithToasts(<EventDetailsModal e={ev({ unread: true, can_mark_unread: true, ...followed })} onClose={vi.fn()} />)
    await userEvent.click(markButton()!)
    expect(unreadButton()).toBeInTheDocument()
  })

  it("does not offer Mark unread where the server says never, or on an archived event", () => {
    const { unmount } = wrapWithToasts(<EventDetailsModal e={ev({ unread: false, ...followed })} onClose={vi.fn()} />)
    expect(unreadButton()).toBeNull()
    unmount()
    // The fixture's default has a resource and no worktrees: archived.
    wrapWithToasts(<EventDetailsModal e={ev({ unread: false, can_mark_unread: true })} onClose={vi.fn()} />)
    expect(unreadButton()).toBeNull()
  })

  it("offers no undo when the mark changed nothing", async () => {
    vi.spyOn(api, "markEventRead").mockResolvedValue({ id: "e1", ts: "2026-08-25T00:00:00Z", previous: "", changed: false })
    wrapWithToasts(<EventDetailsModal e={ev({ unread: true })} onClose={vi.fn()} />)
    await userEvent.click(markButton()!)
    expect(outlined()).toBe(false)
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull()
  })

  it("stays unread and says so when the mark fails", async () => {
    vi.spyOn(api, "markEventRead").mockRejectedValue(new Error("event changed since it was shown"))
    wrapWithToasts(<EventDetailsModal e={ev({ unread: true })} onClose={vi.fn()} />)
    await userEvent.click(markButton()!)
    expect(await screen.findByText(/event changed since it was shown/)).toBeInTheDocument()
    expect(outlined()).toBe(true)
  })
})

// The diff itself is DescriptionDiff's to test; here it only shows what it got.
vi.mock("./DescriptionDiff", () => ({
  default: ({ oldText, newText, cacheKey }: { oldText: string; newText: string; cacheKey: string }) => (
    <div data-testid="description-diff" data-cache-key={cacheKey}>{`${oldText}→${newText}`}</div>
  ),
}))

describe("EventDetailsModal description diffs", () => {
  const DESC_ID = "4f1d2c3b-6a5e-4d7c-8b9a-0e1f2a3b4c5d"
  const descEvent = (o: Partial<TimelineEvent> = {}) =>
    ev({ id: DESC_ID, type: "jira_description_changed", type_label: "description changes", source: "jira",
      title: "PROJ-1 description changed", body: "a summary line", unread: true, ...o })
  // Answers the text endpoint as given; anything else fails, as with no server.
  const stubFetch = (answer: () => Response | Promise<Response>) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith("/api/event-text-change")) return answer()
      throw new TypeError("no server")
    })
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  const textCalls = (spy: ReturnType<typeof stubFetch>) =>
    spy.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/event-text-change"))

  it.each(["jira_description_changed", "pr_description_changed"])("shows the diff for %s, in place of the body", async (type) => {
    const spy = stubFetch(() => json(200, { old_text: "before", new_text: "after" }))
    wrap(<EventDetailsModal e={descEvent({ type })} onClose={vi.fn()} />)
    const diff = await screen.findByTestId("description-diff")
    expect(diff).toHaveTextContent("before→after")
    expect(diff).toHaveAttribute("data-cache-key", DESC_ID)
    expect(textCalls(spy)).toEqual([`/api/event-text-change?id=${DESC_ID}`])
    expect(screen.queryByText("a summary line")).toBeNull()
  })

  it("says so when the edit has no stored text", async () => {
    const spy = stubFetch(() => json(404, { error: "no text stored for this event" }))
    wrap(<EventDetailsModal e={descEvent()} onClose={vi.fn()} />)
    expect(await screen.findByText("Diff not available for this edit.")).toBeInTheDocument()
    // A 404 is an answer, not a failure: asked once.
    expect(textCalls(spy)).toHaveLength(1)
    expect(screen.queryByTestId("description-diff")).toBeNull()
  })

  it("retries any other failure, then shows it inline", async () => {
    const spy = stubFetch(() => json(500, { error: "database is locked" }))
    // The query's own retry policy, without waiting out its backoff.
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })}>
          <EventDetailsModal e={descEvent()} onClose={vi.fn()} />
        </QueryClientProvider>
      </MantineProvider>,
    )
    expect(await screen.findByText(/database is locked/)).toBeInTheDocument()
    expect(textCalls(spy)).toHaveLength(4)
    expect(screen.queryByText("Diff not available for this edit.")).toBeNull()
  })

  it("shows the header and actions while the text loads", () => {
    stubFetch(() => new Promise<Response>(() => {}))
    wrap(<EventDetailsModal e={descEvent()} onClose={vi.fn()} onMakeTask={vi.fn()} />)
    expect(screen.getByText("PROJ-1 description changed")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Mark read" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Make task" })).toBeInTheDocument()
    expect(screen.getByText("Loading diff…")).toBeInTheDocument()
    expect(screen.queryByTestId("description-diff")).toBeNull()
  })

  it("leaves other events' bodies alone, and never asks for text", () => {
    const spy = stubFetch(() => json(200, { old_text: "x", new_text: "y" }))
    wrap(<EventDetailsModal e={ev({ body: "a plain comment" })} onClose={vi.fn()} />)
    expect(screen.getByText("a plain comment")).toBeInTheDocument()
    expect(textCalls(spy)).toEqual([])
    expect(screen.queryByTestId("description-diff")).toBeNull()
  })
})
