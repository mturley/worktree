import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { WatcherStatus } from "../../api/types"
import { WatcherLogsButton } from "./WatcherLogsButton"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderButton(watchers: WatcherStatus[] | null, props: { fullScreen?: boolean } = {}) {
  if (watchers === null) vi.spyOn(api, "watchers").mockReturnValue(new Promise(() => {}))
  else vi.spyOn(api, "watchers").mockResolvedValue({ polling: false, watchers })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider><WatcherLogsButton {...props} /></MantineProvider>
    </QueryClientProvider>,
  )
}

const healthy: WatcherStatus[] = [
  { name: "github", type: "pr" },
  { name: "jira", type: "jira" },
]

describe("WatcherLogsButton", () => {
  it("shows a plain logs icon when every watcher is healthy", async () => {
    renderButton(healthy)
    expect(await screen.findByRole("button", { name: "Watcher logs" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /failing/ })).toBeNull()
  })

  it("shows a plain logs icon before watcher status loads", () => {
    renderButton(null)
    expect(screen.getByRole("button", { name: "Watcher logs" })).toBeInTheDocument()
  })

  it("turns into a warning when a watcher is failing", async () => {
    renderButton([{ name: "github", type: "pr", has_error: true, error_message: "401" }, { name: "jira", type: "jira" }])
    expect(await screen.findByRole("button", { name: "Watcher logs (watchers failing)" })).toBeInTheDocument()
  })

  it("names one failing watcher in the tooltip", async () => {
    renderButton([{ name: "github", type: "pr", has_error: true }, { name: "jira", type: "jira" }])
    await userEvent.hover(await screen.findByRole("button", { name: /failing/ }))
    expect(await screen.findByText("GitHub watcher failing — open logs")).toBeInTheDocument()
  })

  it("names every failing watcher in the tooltip", async () => {
    renderButton([{ name: "github", type: "pr", has_error: true }, { name: "jira", type: "jira", has_error: true }])
    await userEvent.hover(await screen.findByRole("button", { name: /failing/ }))
    expect(await screen.findByText("GitHub and Jira watchers failing — open logs")).toBeInTheDocument()
  })

  it("fetches nothing until opened, then shows the watcher log and resource status sub-tabs", async () => {
    const log = vi.spyOn(api, "watcherLog").mockResolvedValue({ entries: [], has_more: false })
    const resources = vi.spyOn(api, "watchedResources").mockResolvedValue({ resources: [] })
    renderButton(healthy)
    await screen.findByRole("button", { name: "Watcher logs" })
    expect(log).not.toHaveBeenCalled()
    expect(resources).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Watcher logs" }))
    expect(await screen.findByRole("dialog", { name: "Watcher logs" })).toBeInTheDocument()
    expect(await screen.findByText("No watcher activity recorded yet.")).toBeInTheDocument()
    expect(resources).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("tab", { name: "Resource status" }))
    expect(await screen.findByText("No resources are being watched.")).toBeInTheDocument()
    expect(resources).toHaveBeenCalled()
  })

  it("unmounts the log once closed", async () => {
    vi.spyOn(api, "watcherLog").mockResolvedValue({ entries: [], has_more: false })
    renderButton(healthy)
    await userEvent.click(await screen.findByRole("button", { name: "Watcher logs" }))
    await screen.findByText("No watcher activity recorded yet.")
    await userEvent.keyboard("{Escape}")
    await vi.waitFor(() => expect(screen.queryByText("No watcher activity recorded yet.")).toBeNull())
  })

  it("opens full screen when asked", async () => {
    vi.spyOn(api, "watcherLog").mockResolvedValue({ entries: [], has_more: false })
    renderButton(healthy, { fullScreen: true })
    await userEvent.click(await screen.findByRole("button", { name: "Watcher logs" }))
    const dialog = await screen.findByRole("dialog", { name: "Watcher logs" })
    expect(dialog.closest("[data-full-screen]")).not.toBeNull()
  })
})
