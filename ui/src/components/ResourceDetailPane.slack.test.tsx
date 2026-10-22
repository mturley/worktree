import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor, within } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { TaskModalProvider } from "./tasks/modal/TaskModalProvider"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import userEvent from "@testing-library/user-event"
import type { ResourceDTO, Task } from "../api/types"
import { TASK_LIST_KEY } from "../lib/taskListPrefs"
import { api } from "../api/client"

if (typeof (globalThis as { EventSource?: unknown }).EventSource !== "function") {
  ;(globalThis as { EventSource: unknown }).EventSource = class {
    close() {}
    set onmessage(_: unknown) {}
    set onerror(_: unknown) {}
  }
}

const useWorktreeTimeline = vi.fn()
vi.mock("../hooks/useTimeline", () => ({
  useWorktreeTimeline: (...a: unknown[]) => useWorktreeTimeline(...a),
}))

// ThreadView is heavy (mrkdwn, emoji, blocks); stand it in so this test is
// about the PANE's routing decision, not the thread renderer's internals.
vi.mock("./slack/ThreadView", () => ({
  ThreadView: ({ tab }: { tab: { channel: string; threadTs: string } }) => (
    <div data-testid="thread-view">{`thread ${tab.channel}/${tab.threadTs}`}</div>
  ),
}))

// A test sets this to stand in for a failed thread fetch.
const threadError: { current: string | undefined } = { current: undefined }
vi.mock("../hooks/useThread", () => ({
  useThread: () => ({ data: undefined, status: "ready", error: threadError.current, refresh: vi.fn(), applyLocal: vi.fn() }),
}))

import { ResourceDetailPane } from "./ResourceDetailPane"

const slack: ResourceDTO = {
  type: "slack", id: "C123:1700000000.000100",
  url: "https://acme.slack.com/archives/C123/p1700000000000100",
  primary: true, custom_name: "Deploy thread",
} as ResourceDTO

const pr: ResourceDTO = {
  type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN",
} as ResourceDTO

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}><TaskModalProvider>{ui}</TaskModalProvider></QueryClientProvider>
    </MantineProvider>,
  )
}

// The active tab lives in the URL (?tab=); start every test on the default.
beforeEach(() => window.history.replaceState({}, "", "/worktree/wt"))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useWorktreeTimeline.mockReset()
})

describe("ResourceDetailPane slack branch", () => {
  it("dots the Thread tab while the thread has unread replies you can't see", async () => {
    vi.spyOn(api, "linkedResources").mockResolvedValue({ fetched_at: "", count: 0, sections: [] })
    wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...slack, has_unread: true }} />)
    expect(screen.queryByLabelText("unread replies")).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole("tab", { name: /Linked Resources/ }))
    expect(screen.getByLabelText("unread replies")).toBeInTheDocument()
  })

  it("does not dot the Thread tab when the thread is read", async () => {
    vi.spyOn(api, "linkedResources").mockResolvedValue({ fetched_at: "", count: 0, sections: [] })
    wrap(<ResourceDetailPane path="/wt/foo" resource={{ ...slack, has_unread: false }} />)
    await userEvent.click(await screen.findByRole("tab", { name: /Linked Resources/ }))
    expect(screen.queryByLabelText("unread replies")).not.toBeInTheDocument()
  })

  it("has Thread and Linked Resources tabs and keeps the thread mounted", async () => {
    vi.spyOn(api, "linkedResources").mockResolvedValue({ fetched_at: "", count: 0, sections: [] })
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)
    expect(await screen.findByRole("tab", { name: "Thread" })).toHaveAttribute("aria-selected", "true")
    const thread = screen.getByTestId("thread-view")
    await userEvent.click(screen.getByRole("tab", { name: /Linked Resources/ }))
    expect(thread).toBeInTheDocument() // still mounted (hidden), so drafts survive
  })

  it("renders the Slack thread instead of the activity feed for a slack resource", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)

    expect(screen.getByTestId("thread-view")).toHaveTextContent("thread C123/1700000000.000100")
    expect(screen.queryByText("Activity")).not.toBeInTheDocument()
  })

  it("renders the shared detail card above the slack thread", () => {
    // Card unification: ThreadView no longer carries its own header block, so
    // the same ResourceCard heads every resource type. Needing ThreadView's
    // header slot twice (remove in phase C, focus/related next) was the
    // signal the seam was in the wrong place.
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} onRemoved={vi.fn()} />)
    expect(screen.getByText("Deploy thread")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open in Slack" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Unfollow resource" })).toBeInTheDocument()
  })

  it("does not request a filtered timeline for a slack resource", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)
    expect(useWorktreeTimeline).not.toHaveBeenCalled()
  })

  it("still renders the activity feed for a non-slack resource", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={pr} />)
    expect(screen.getByText("Activity")).toBeInTheDocument()
    expect(screen.queryByTestId("thread-view")).not.toBeInTheDocument()
  })

  it("keeps the narrow-viewport back control for a slack thread", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} onBack={vi.fn()} />)
    expect(screen.getByRole("button", { name: /all resources/i })).toBeInTheDocument()
  })
})

describe("ResourceDetailPane slack remove control", () => {
  it("puts the remove control on the shared card, not in a ThreadView slot", () => {
    // Phase B gives a slack thread no detail ResourceCard, so without this the
    // thread would be the one resource type you cannot remove from the UI.
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} onRemoved={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Unfollow resource" })).toBeInTheDocument()
  })
})

describe("ResourceDetailPane slack tasks", () => {
  const task: Task = {
    id: 4, ref: "T4", title: "Answer the thread", description: "", state: "not_started", priority: "none", starred: false,
    rank: "r1", created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
    subtasks_total: 0, subtasks_done: 0,
  }
  beforeEach(() => {
    window.localStorage.clear()
    vi.spyOn(api, "tasks").mockResolvedValue([task])
    vi.spyOn(api, "linkedResources").mockResolvedValue({ fetched_at: "", count: 0, sections: [] })
  })

  it("Thread · Linked Resources · Tasks, Tasks last with a count", async () => {
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab")
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, "").replace(/ \(\d+\)$/, ""))).toEqual(["Thread", "Linked Resources", "Tasks"])
    expect((await within(tabs[2]!).findByText("1")).closest(".task-count-badge")).not.toBeNull()
    expect(api.tasks).toHaveBeenCalledWith({ kind: "resource", type: "slack", id: slack.id }, expect.anything())
    await userEvent.click(tabs[2]!)
    expect(await screen.findByText("Answer the thread")).toBeInTheDocument()
    expect(within(screen.getByRole("tablist")).getByRole("button", { name: "Pin task list" })).toBeInTheDocument()
  })

  it("pinned: the list sits between the card and the tab bar", async () => {
    window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ pinned: true }))
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)
    const panel = document.querySelector(".task-panel") as HTMLElement
    expect(await within(panel).findByText("Answer the thread")).toBeInTheDocument()
    const bar = screen.getByRole("tablist")
    expect(within(bar).queryByRole("tab", { name: /Tasks/ })).toBeNull()
    expect(panel.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const title = screen.getAllByText("Deploy thread")[0]!
    expect(title.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("pinning while on Tasks falls back to Thread", async () => {
    wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)
    await userEvent.click(await screen.findByRole("tab", { name: /Tasks/ }))
    await userEvent.click(screen.getByRole("button", { name: "Pin task list" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Thread" })).toHaveAttribute("aria-selected", "true"))
  })
})

/*
 * Tasks contact no external service, so a thread that can't be shown (the
 * Slack watcher off, or Slack not configured) still has its task list.
 */
describe("ResourceDetailPane slack tasks without a thread", () => {
  const task: Task = {
    id: 5, ref: "T5", title: "Follow up on the thread", description: "", state: "not_started", priority: "none",
    starred: false, rank: "r1", created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
    subtasks_total: 0, subtasks_done: 0,
  }
  const off = { github: { enabled: true, failing: false }, jira: { enabled: true, failing: false }, slack: { enabled: false, failing: false } }
  beforeEach(() => {
    window.localStorage.clear()
    vi.spyOn(api, "tasks").mockResolvedValue([task])
    vi.spyOn(api, "linkedResources").mockResolvedValue({ fetched_at: "", count: 0, sections: [] })
  })
  afterEach(() => {
    threadError.current = undefined
  })

  const cases = {
    "watcher off": {
      setup: () => {
        vi.spyOn(api, "watcherHealth").mockResolvedValue(off)
      },
      notice: "The thread can't be shown while the Slack watcher is disabled.",
    },
    "not configured": {
      setup: () => {
        threadError.current = "HTTP 503: slack not configured"
      },
      notice: "Slack not configured",
    },
  }

  for (const [name, { setup, notice }] of Object.entries(cases)) {
    it(`${name}: keeps the notice, with a Tasks tab beside it`, async () => {
      setup()
      wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)
      expect(await screen.findByText(notice)).toBeInTheDocument()
      const tabs = within(screen.getByRole("tablist")).getAllByRole("tab")
      expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Thread", "Tasks"])
      await userEvent.click(tabs[1]!)
      expect(await screen.findByText("Follow up on the thread")).toBeInTheDocument()
    })

    it(`${name}: pinned, the list shows with the notice`, async () => {
      setup()
      window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ pinned: true }))
      wrap(<ResourceDetailPane path="/wt/foo" resource={slack} />)
      expect(await screen.findByText(notice)).toBeInTheDocument()
      const panel = document.querySelector(".task-panel") as HTMLElement
      expect(panel).not.toBeNull()
      expect(await within(panel).findByText("Follow up on the thread")).toBeInTheDocument()
    })
  }
})
