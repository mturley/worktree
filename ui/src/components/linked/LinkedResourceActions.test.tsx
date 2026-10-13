import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { CmuxResponse, LinkedItem } from "../../api/types"
import { LinkedActionsContext, type LinkedActions } from "./LinkedActionsContext"
import { LinkedResourceActions } from "./LinkedResourceActions"

const item = (over: Partial<LinkedItem> = {}): LinkedItem =>
  ({ type: "jira", id: "PROJ-9", url: "https://example.atlassian.net/browse/PROJ-9", resolved: true, ...over })

function wrap(ui: React.ReactNode, actions: LinkedActions = {}) {
  return render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <LinkedActionsContext.Provider value={actions}>{ui}</LinkedActionsContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("LinkedResourceActions", () => {
  it("Follow opens the follow modal with the URL", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] })
    const requestFollow = vi.fn()
    wrap(<LinkedResourceActions item={item()} />, { requestFollow, trackedResource: () => null })
    await userEvent.click(screen.getByRole("button", { name: "Follow" }))
    expect(requestFollow).toHaveBeenCalledWith("https://example.atlassian.net/browse/PROJ-9")
  })

  it("nothing followed or open: every button is subtle", () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] })
    wrap(<LinkedResourceActions item={item()} />, { requestFollow: vi.fn(), trackedResource: () => null })
    expect(screen.getByRole("button", { name: "Follow" })).toHaveAttribute("data-variant", "subtle")
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("data-variant", "subtle")
    expect(screen.getByRole("button", { name: /copy link/i })).toHaveAttribute("data-variant", "subtle")
  })

  it("an already-followed resource offers Following instead", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] })
    const selectResource = vi.fn()
    wrap(<LinkedResourceActions item={item()} />, {
      requestFollow: vi.fn(),
      trackedResource: (t, id) => (t === "jira" && id === "PROJ-9" ? { type: "jira", id: "PROJ-9" } : null),
      selectResource,
    })
    expect(screen.queryByRole("button", { name: "Follow" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Following" })).toHaveAttribute("data-variant", "light")
    await userEvent.click(screen.getByRole("button", { name: "Following" }))
    expect(selectResource).toHaveBeenCalledWith({ type: "jira", id: "PROJ-9" })
  })

  it("Open is a new-tab link; Slack says Open in Slack", () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] })
    wrap(<LinkedResourceActions item={item()} />)
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("target", "_blank")
    cleanup()
    wrap(<LinkedResourceActions item={item({ type: "slack", id: "C0TEST:1.2", url: "https://x.slack.com/archives/C0TEST/p12" })} />)
    expect(screen.getByRole("link", { name: "Open in Slack" })).toBeInTheDocument()
  })

  it("an issue open in a cmux tab offers Open (switch)", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, workspaces: [], matches: {} } as unknown as CmuxResponse)
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({
      available: true,
      tabs: [{ workspaceId: "w1", workspaceRef: "workspace:1", workspaceTitle: "ws", workspaceSelected: false, pane: "pane:1", surface: "s1",
        url: "https://example.atlassian.net/browse/PROJ-9" }],
    })
    const focus = vi.spyOn(api, "cmuxFocusTab").mockResolvedValue({ ok: true })
    wrap(<LinkedResourceActions item={item()} />)
    const sw = await screen.findByRole("button", { name: "Open (switch)" })
    expect(sw).toHaveAttribute("data-variant", "light")
    expect(screen.getByRole("button", { name: "More open options" })).toHaveAttribute("data-variant", "light")
    await userEvent.click(sw)
    expect(focus).toHaveBeenCalledWith("w1", "s1")
  })

  it("hideFollow hides both Follow and Following", () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] })
    wrap(<LinkedResourceActions item={item()} hideFollow />, { requestFollow: vi.fn(), trackedResource: () => null })
    expect(screen.queryByRole("button", { name: "Follow" })).not.toBeInTheDocument()
  })

  it("copies the URL", async () => {
    vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] })
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    wrap(<LinkedResourceActions item={item()} />)
    await user.click(screen.getByRole("button", { name: /copy link/i }))
    expect(writeText).toHaveBeenCalledWith("https://example.atlassian.net/browse/PROJ-9")
  })
})
