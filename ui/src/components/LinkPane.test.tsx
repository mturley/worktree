import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { TaskModalProvider } from "./tasks/modal/TaskModalProvider"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO, Task } from "../api/types"
import { TASK_LIST_KEY } from "../lib/taskListPrefs"

const resolveResource = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: {
    ...actual.api,
    resolveResource: (...args: unknown[]) => resolveResource(...args),
  } }
})

import { LinkPane } from "./LinkPane"
import { api } from "../api/client"

const link = (overrides: Partial<ResourceDTO> = {}): ResourceDTO => ({
  type: "link", id: "https://ex.com/a", url: "https://ex.com/a", primary: true,
  title: "Example page", ...overrides,
} as ResourceDTO)

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}><TaskModalProvider>{ui}</TaskModalProvider></QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => {
  resolveResource.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  resolveResource.mockReset()
})

describe("LinkPane", () => {
  it("frames an embeddable page with the exact sandbox we intend", () => {
    const { container } = wrap(<LinkPane resource={link({ embeddable: true })} path="/wt" />)
    const frame = container.querySelector("iframe") as HTMLIFrameElement
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms allow-popups")
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer")
    // Withheld on purpose: the framed page must not navigate us away or download.
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation")
    expect(frame.getAttribute("sandbox")).not.toContain("allow-downloads")
  })

  it("explains a page that refuses framing instead of showing a blank box", () => {
    wrap(<LinkPane resource={link({ embeddable: false })} path="/wt" />)
    expect(screen.getByText("Can't embed page")).toBeInTheDocument()
    // Scoped to the panel: the detail card above it legitimately renders its
    // own "Open in new tab" action too, so an unscoped getByRole would match
    // two elements with the same accessible name — ambiguous by design, not
    // by accident. The Alert's root carries role="alert" (Mantine v7). Named
    // by its title so it stays unambiguous if ResourceCard's own error Alert
    // (remove/primary failures) ever renders alongside it.
    const panel = screen.getByRole("alert", { name: "Can't embed page" })
    expect(within(panel).getByRole("link", { name: "Open in new tab" })).toBeInTheDocument()
  })

  it("never frames our own origin, even when embeddable is true", () => {
    // The origin guard in canEmbed is unit-tested directly in
    // linkEmbed.test.ts, but that alone would not catch a regression where
    // LinkPane passed a hardcoded/wrong origin into canEmbed. This proves
    // LinkPane consults the REAL environment origin (window.location.origin,
    // as jsdom sets it) rather than something else.
    const { container } = wrap(
      <LinkPane resource={link({ url: `${window.location.origin}/worktree/x`, embeddable: true })} path="/wt" />,
    )
    expect(container.querySelector("iframe")).toBeNull()
    expect(screen.getByRole("alert", { name: "Can't embed page" })).toBeInTheDocument()
  })

  it("renders no iframe at all for a page that refuses framing", () => {
    const { container } = wrap(<LinkPane resource={link({ embeddable: false })} path="/wt" />)
    expect(container.querySelector("iframe")).toBeNull()
  })

  it("shows no activity feed and no unread affordances", () => {
    wrap(<LinkPane resource={link({ embeddable: true })} path="/wt" />)
    expect(screen.queryByText("Activity")).toBeNull()
    expect(screen.queryByRole("button", { name: /mark .* as read/i })).toBeNull()
    expect(screen.queryByRole("button", { name: "Refresh watchers" })).toBeNull()
  })

  it("offers a refresh that re-resolves the page", async () => {
    resolveResource.mockResolvedValue({})
    wrap(<LinkPane resource={link({ embeddable: true })} path="/wt" />)
    await userEvent.click(screen.getByRole("button", { name: "Refresh page details" }))
    expect(resolveResource).toHaveBeenCalledWith({ type: "link", id: "https://ex.com/a" })
  })

  it("shows an error alert when resolve_error is set", () => {
    wrap(<LinkPane resource={link({ resolve_error: "timeout" })} path="/wt" />)
    expect(screen.getByText("Couldn't load page details")).toBeInTheDocument()
  })
})

describe("LinkPane tasks", () => {
  const task: Task = {
    id: 7, ref: "T7", title: "Read the page", description: "", state: "not_started", priority: "none", starred: false,
    rank: "r1", created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
    subtasks_total: 0, subtasks_done: 0,
  }
  beforeEach(() => {
    window.history.replaceState({}, "", "/worktree/wt")
    window.localStorage.clear()
    vi.spyOn(api, "tasks").mockResolvedValue([task])
  })
  afterEach(() => vi.restoreAllMocks())

  it("has Details · Tasks tabs, with today's content under Details", async () => {
    wrap(<LinkPane resource={link({ embeddable: false })} path="/wt" />)
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab")
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Details", "Tasks"])
    expect(tabs[0]).toHaveAttribute("aria-selected", "true")
    expect((await within(tabs[1]!).findByText("1")).closest(".task-count-badge")).not.toBeNull()
    const details = screen.getByRole("tabpanel")
    expect(within(details).getByText("Can't embed page")).toBeInTheDocument()
    expect(within(details).getByRole("button", { name: "Refresh page details" })).toBeInTheDocument()

    await userEvent.click(tabs[1]!)
    expect(await screen.findByText("Read the page")).toBeInTheDocument()
    expect(within(screen.getByRole("tablist")).getByRole("button", { name: "Pin task list" })).toBeInTheDocument()
    expect(api.tasks).toHaveBeenCalledWith({ kind: "resource", type: "link", id: "https://ex.com/a" }, expect.anything())
  })

  it("pinned: the list sits between the card and the tab bar, and Tasks is not a tab", async () => {
    window.localStorage.setItem(TASK_LIST_KEY, JSON.stringify({ pinned: true }))
    wrap(<LinkPane resource={link({ embeddable: false })} path="/wt" />)
    const panel = document.querySelector(".task-panel") as HTMLElement
    expect(await within(panel).findByText("Read the page")).toBeInTheDocument()
    const bar = screen.getByRole("tablist")
    expect(within(bar).queryByRole("tab", { name: /Tasks/ })).toBeNull()
    expect(panel.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const title = screen.getAllByText("Example page")[0]!
    expect(title.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("pinning while on Tasks falls back to Details", async () => {
    wrap(<LinkPane resource={link({ embeddable: false })} path="/wt" />)
    await userEvent.click(screen.getByRole("tab", { name: /Tasks/ }))
    await userEvent.click(screen.getByRole("button", { name: "Pin task list" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true"))
  })
})
