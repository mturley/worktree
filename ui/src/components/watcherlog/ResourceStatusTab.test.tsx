import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { WatchedResourceStatus } from "../../api/types"
import { ResourceStatusTab } from "./ResourceStatusTab"

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
if (typeof window.ResizeObserver !== "function") {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
}

const watchedResources = vi.fn()
vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return { api: { ...actual.api, watchedResources: (...a: unknown[]) => watchedResources(...a) } }
})

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MantineProvider>{ui}</MantineProvider>
    </QueryClientProvider>,
  )

afterEach(() => {
  cleanup()
  watchedResources.mockReset()
})

const res = (over: Partial<WatchedResourceStatus>): WatchedResourceStatus => ({
  type: "pr", id: "o/r#1", name: "Fix it", worktrees: ["/w"], status: "ok", ...over,
})

describe("ResourceStatusTab", () => {
  it("renders rows in server order with status icons and names linked", async () => {
    watchedResources.mockResolvedValue({
      resources: [
        res({ type: "slack", id: "C1:1.2", name: "Thread", status: "error", error_message: "Failed to fetch thread: slack error: thread_not_found",
          last_error: "2026-10-13T06:04:23.000000Z", url: "https://x.slack.com/archives/C1/p12" }),
        res({ last_success: new Date().toISOString(), url: "https://github.com/o/r/pull/1" }),
        res({ type: "jira", id: "ABC-1", name: "ABC-1", status: "never" }),
      ],
    })
    wrap(<ResourceStatusTab scope={{}} />)
    await screen.findByText("Thread")
    const rows = screen.getAllByRole("row")
    expect(rows.slice(1).map((r) => r.textContent)).toEqual([
      expect.stringContaining("Thread"),
      expect.stringContaining("Fix it"),
      expect.stringContaining("ABC-1"),
    ])
    expect(screen.getByLabelText("error")).toBeTruthy()
    expect(screen.getByLabelText("ok")).toBeTruthy()
    expect(screen.getByLabelText("never polled")).toBeTruthy()
    expect(screen.getAllByText("Never")).toHaveLength(2) // slack error row + jira never row
    expect(screen.getByRole("link", { name: "Fix it" }).getAttribute("href")).toBe("https://github.com/o/r/pull/1")
  })

  it("tooltip shows last poll details", async () => {
    watchedResources.mockResolvedValue({
      resources: [res({ status: "error", error_message: "GitHub API error: Unicorn! · GitHub", last_attempt: "2026-10-13T13:18:32.000000Z",
        detail: { ok: false, http_status: 504, duration_ms: 12300, events_emitted: 0 } })],
    })
    const user = userEvent.setup()
    wrap(<ResourceStatusTab scope={{}} />)
    await user.hover(await screen.findByLabelText("error"))
    expect(await screen.findByText(/GitHub API error: Unicorn! · GitHub/)).toBeTruthy()
    expect(screen.getByText(/HTTP 504/)).toBeTruthy()
    expect(screen.getByText(/12.3 s/)).toBeTruthy()
  })

  it("empty state", async () => {
    watchedResources.mockResolvedValue({ resources: [] })
    wrap(<ResourceStatusTab scope={{}} />)
    expect(await screen.findByText("No resources are being watched.")).toBeTruthy()
  })

  it("shows an error instead of the empty state when the query fails", async () => {
    watchedResources.mockRejectedValue(new Error("boom"))
    wrap(<ResourceStatusTab scope={{}} />)
    expect(await screen.findByText(/Couldn't load resource status: boom/)).toBeTruthy()
    expect(screen.queryByText("No resources are being watched.")).toBeNull()
  })

  it("header click cycles a column's sort asc, desc, off; one column at a time", async () => {
    watchedResources.mockResolvedValue({
      resources: [
        res({ type: "slack", id: "s", name: "Thread", status: "error" }),
        res({ type: "pr", id: "p", name: "Fix it", status: "ok" }),
        res({ type: "jira", id: "j", name: "ABC-1", status: "never" }),
      ],
    })
    const user = userEvent.setup()
    wrap(<ResourceStatusTab scope={{}} />)
    await screen.findByText("Thread")
    const order = () => screen.getAllByRole("row").slice(1).map((r) => r.querySelector("td:nth-child(2)")?.textContent)
    const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name) })

    expect(order()).toEqual(["Thread", "Fix it", "ABC-1"])
    await user.click(screen.getByRole("button", { name: /Source/ }))
    expect(header("Source").getAttribute("aria-sort")).toBe("ascending")
    expect(order()).toEqual(["Fix it", "ABC-1", "Thread"])
    await user.click(screen.getByRole("button", { name: /Source/ }))
    expect(header("Source").getAttribute("aria-sort")).toBe("descending")
    expect(order()).toEqual(["Thread", "ABC-1", "Fix it"])
    await user.click(screen.getByRole("button", { name: /Source/ }))
    expect(header("Source").getAttribute("aria-sort")).toBe("none")
    expect(order()).toEqual(["Thread", "Fix it", "ABC-1"])

    await user.click(screen.getByRole("button", { name: /Source/ }))
    await user.click(screen.getByRole("button", { name: /Status/ }))
    expect(header("Source").getAttribute("aria-sort")).toBe("none")
    expect(header("Status").getAttribute("aria-sort")).toBe("ascending")
    expect(order()).toEqual(["Thread", "Fix it", "ABC-1"])
    await user.click(screen.getByRole("button", { name: /Status/ }))
    expect(order()).toEqual(["ABC-1", "Fix it", "Thread"])
  })
})
