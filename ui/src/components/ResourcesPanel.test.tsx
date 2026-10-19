import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AllResourceDTO } from "../api/types"
import { api } from "../api/client"
import { useResourcesView } from "../hooks/useResourcesView"
import { ResourcesPanel, ResourcesTabControls } from "./ResourcesPanel"

function Harness({ unreadOnly }: { unreadOnly: boolean }) {
  const view = useResourcesView(unreadOnly)
  return <ResourcesPanel view={view} top={<ResourcesTabControls view={view} />} />
}

const a = { path: "/wt/a", repo: "r", branch: "branch-a" }
const b = { path: "/wt/b", repo: "r", branch: "branch-b" }
const data: AllResourceDTO[] = [
  { type: "pr", id: "o/r#1", url: "https://github.com/o/r/pull/1", primary: true, title: "My open PR", state: "OPEN",
    mine: true, updated_at: "2026-01-03T00:00:00Z", worktrees: [b, a] },
  { type: "pr", id: "o/r#2", url: "https://github.com/o/r/pull/2", primary: false, title: "Merged PR", state: "MERGED",
    updated_at: "2026-01-01T00:00:00Z", worktrees: [a] },
  { type: "jira", id: "J-1", url: "https://x.atlassian.net/browse/J-1", primary: true, title: "An issue", status: "In Progress",
    unread_count: 3, updated_at: "2026-01-02T00:00:00Z", worktrees: [a] },
]

const wrap = (unreadOnly = false) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider><Harness unreadOnly={unreadOnly} /></MantineProvider>
    </QueryClientProvider>,
  )

const TITLES = ["My open PR", "Merged PR", "An issue"]
const titles = () =>
  screen.getAllByTestId("all-resource-row").map((r) => TITLES.find((t) => within(r).queryByText(t)))

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  vi.spyOn(api, "allResources").mockResolvedValue(data)
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
  vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] } as never)
})
afterEach(() => vi.restoreAllMocks())
afterEach(cleanup)

describe("ResourcesPanel", () => {
  it("lists every resource, most recently updated first", async () => {
    wrap()
    await screen.findByText("My open PR")
    expect(titles()).toEqual(["My open PR", "An issue", "Merged PR"])
    expect(screen.getByText("3 resources")).toBeInTheDocument()
  })

  it("highlights unread resources", async () => {
    wrap()
    const row = (await screen.findByText("An issue")).closest("[data-testid='all-resource-row']")!
    expect(row).toHaveAttribute("data-unread", "true")
    expect(within(row as HTMLElement).getByText("3 unreads")).toBeInTheDocument()
  })

  it("shows only unread resources when unread-only is on", async () => {
    wrap(true)
    await screen.findByText("An issue")
    expect(titles()).toEqual(["An issue"])
    expect(screen.getByText("1 of 3 resources")).toBeInTheDocument()
  })

  it("opens a type's subfilters, and filters by them", async () => {
    const user = userEvent.setup()
    wrap()
    await screen.findByText("My open PR")
    expect(screen.queryByTestId("resource-subfilters")).toBeNull()
    await user.click(screen.getByRole("button", { name: "GitHub" }))
    expect(titles()).toEqual(["My open PR", "Merged PR"])
    await user.click(screen.getByRole("button", { name: "Merged" }))
    expect(titles()).toEqual(["Merged PR"])
    await user.click(screen.getByRole("button", { name: "Merged" }))
    await user.click(screen.getByRole("button", { name: "My PRs" }))
    expect(titles()).toEqual(["My open PR"])
    // Jira's statuses come from the data.
    await user.click(screen.getByRole("button", { name: "Jira" }))
    expect(screen.getByRole("button", { name: "In Progress" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "My issues" })).toBeInTheDocument()
    expect(titles()).toEqual(["An issue"])
  })

  it("puts My Stuff first and shows only the user's PRs and issues", async () => {
    const user = userEvent.setup()
    wrap()
    await screen.findByText("My open PR")
    const toggles = screen.getAllByRole("button", { name: /My Stuff|GitHub|Jira|Slack/ })
    expect(toggles[0]).toHaveTextContent("My Stuff")
    await user.click(screen.getByRole("button", { name: "My Stuff" }))
    expect(titles()).toEqual(["My open PR"])
    expect(screen.queryByTestId("resource-subfilters")).toBeNull()
  })

  it("sorts by status", async () => {
    const user = userEvent.setup()
    wrap()
    await screen.findByText("My open PR")
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort resources" }), "status")
    expect(titles()).toEqual(["My open PR", "An issue", "Merged PR"])
  })

  it("goes straight to the one worktree following a resource on a row click", async () => {
    const user = userEvent.setup()
    wrap()
    const row = (await screen.findByText("Merged PR")).closest("[data-testid='all-resource-row']") as HTMLElement
    expect(within(row).queryByRole("button", { name: "Details" })).toBeNull()
    await user.click(within(row).getByText("Merged PR"))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/a")}`)
    expect(new URLSearchParams(window.location.search).get("resource")).toContain("o/r#2")
  })

  it("asks which worktree when several follow the resource", async () => {
    const user = userEvent.setup()
    wrap()
    const row = (await screen.findByText("My open PR")).closest("[data-testid='all-resource-row']") as HTMLElement
    await user.click(row)
    expect(window.location.pathname).toBe("/")
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("My open PR")).toBeInTheDocument()
    expect(within(dialog).getByText(/followed by 2 worktrees/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "view in branch-a" }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/a")}`)
    expect(new URLSearchParams(window.location.search).get("resource")).toContain("o/r#1")
  })

  it("names the open buttons for their service, and they do not navigate", async () => {
    const user = userEvent.setup()
    wrap()
    const row = (await screen.findByText("Merged PR")).closest("[data-testid='all-resource-row']") as HTMLElement
    expect(within(row).getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", "https://github.com/o/r/pull/2")
    const jira = screen.getByText("An issue").closest("[data-testid='all-resource-row']") as HTMLElement
    expect(within(jira).getByRole("link", { name: "Open on Jira" })).toBeInTheDocument()
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
    await user.click(within(row).getByRole("button", { name: "Copy link" }))
    expect(window.location.pathname).toBe("/")
  })
})
