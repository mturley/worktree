import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SourceFilter } from "./SourceFilter"
import type { WatchersResponse } from "../api/types"

const watchers = vi.fn<() => Promise<WatchersResponse>>()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api, watchers: () => watchers() } }
})

// The toggles now carry watcher freshness, so they read a query. A fresh
// client per render keeps one test's status out of the next one's.
const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {ui}
      </QueryClientProvider>
    </MantineProvider>,
  )
beforeEach(() => watchers.mockResolvedValue({ watchers: [], polling: false }))
afterEach(() => { cleanup(); watchers.mockReset() })

describe("SourceFilter", () => {
  it("offers one toggle per source, named for the service", () => {
    wrap(<SourceFilter value={[]} onChange={vi.fn()} />)
    for (const name of ["GitHub", "Jira", "Slack"]) {
      expect(screen.getByRole("button", { name: new RegExp(name, "i") })).toBeInTheDocument()
    }
  })

  it("adds a source on click and reports it as pressed", () => {
    const onChange = vi.fn()
    wrap(<SourceFilter value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: /github/i }))
    // "pr" is the resource type behind the "GitHub" label.
    expect(onChange).toHaveBeenCalledWith(["pr"])
  })

  it("replaces the selection rather than adding to it", () => {
    // Single-select: picking Jira drops GitHub.
    const onChange = vi.fn()
    wrap(<SourceFilter value={["pr"]} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: /jira/i }))
    expect(onChange).toHaveBeenCalledWith(["jira"])
  })

  it("clears back to everything when the active source is clicked again", () => {
    // The only way back to an unfiltered feed, so it has to work.
    const onChange = vi.fn()
    wrap(<SourceFilter value={["jira"]} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: /jira/i }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("marks selected sources with aria-pressed", () => {
    wrap(<SourceFilter value={["slack"]} onChange={vi.fn()} />)
    expect(screen.getByRole("button", { name: /slack/i })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: /jira/i })).toHaveAttribute("aria-pressed", "false")
  })
})

describe("SourceFilter branding", () => {
  it("uses each source's official mark, with its colour in the artwork", () => {
    const { container } = wrap(<SourceFilter value={[]} onChange={vi.fn()} />)
    const svgs = [...container.querySelectorAll("svg")]
    expect(svgs).toHaveLength(3)

    // Slack: its own four-colour mark, colours baked into the fills.
    const slackFills = [...svgs[2].querySelectorAll("path")].map((p) => p.getAttribute("fill"))
    expect(slackFills).toContain("#36C5F0")

    // Jira: Atlassian's own mark — the brand blue is baked into the artwork.
    const jiraFills = [...svgs[1].querySelectorAll("path")].map((p) => p.getAttribute("fill"))
    expect(jiraFills).toContain("#1868DB")

    // GitHub: the Invertocat is monochrome by design, and white is the
    // variant GitHub ships for dark backgrounds — so the colour is part of
    // the artwork, not applied from outside.
    const ghFills = [...svgs[0].querySelectorAll("path")].map((p) => p.getAttribute("fill"))
    expect(ghFills).toContain("white")
  })
})

describe("watcher status in the toggles", () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

  it("shows each source's last SUCCESSFUL run beside its name", async () => {
    watchers.mockResolvedValue({
      polling: false,
      watchers: [
        // "pr", not "github": the poller's name and the filter's type differ,
        // and getting the mapping wrong leaves this toggle statusless.
        { name: "github", type: "pr", last_success: minutesAgo(3) },
        { name: "jira", type: "jira", last_success: minutesAgo(11) },
      ],
    })
    wrap(<SourceFilter value={[]} onChange={vi.fn()} />)
    expect(await screen.findByText("(3m ago)")).toBeInTheDocument()
    expect(screen.getByText("(11m ago)")).toBeInTheDocument()
  })

  it("marks a failing watcher and offers its error", async () => {
    watchers.mockResolvedValue({
      polling: false,
      watchers: [{ name: "slack", type: "slack", last_success: minutesAgo(9), has_error: true, error_message: "token expired" }],
    })
    wrap(<SourceFilter value={[]} onChange={vi.fn()} />)
    expect(await screen.findByLabelText("slack watcher failing")).toBeInTheDocument()
    // The time shown is still the last SUCCESS, so it reads as "working until
    // 9 minutes ago" rather than "just ran fine".
    expect(screen.getByText("(9m ago)")).toBeInTheDocument()
  })

  it("says nothing at all for a source that has never run", async () => {
    // A fresh install or an unconfigured source: "never" would imply a fault.
    watchers.mockResolvedValue({ polling: false, watchers: [{ name: "jira", type: "jira" }] })
    wrap(<SourceFilter value={[]} onChange={vi.fn()} />)
    await screen.findByRole("button", { name: /jira/i })
    expect(screen.queryByText(/ago\)/)).toBeNull()
    expect(screen.queryByLabelText(/watcher failing/)).toBeNull()
  })

  it("still renders every toggle when the status request fails", async () => {
    // The filter is the primary control; losing the annotation must not lose
    // the buttons.
    watchers.mockRejectedValue(new Error("boom"))
    wrap(<SourceFilter value={[]} onChange={vi.fn()} />)
    for (const name of ["GitHub", "Jira", "Slack"]) {
      expect(screen.getByRole("button", { name: new RegExp(name, "i") })).toBeInTheDocument()
    }
  })
})
