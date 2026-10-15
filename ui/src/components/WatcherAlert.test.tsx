import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import type { WatcherHealth } from "../api/types"
import { WatcherAlert } from "./WatcherAlert"
import { SettingsProvider } from "./settings/SettingsContext"
import { baseSettings } from "./settings/testSettings"

const healthy: WatcherHealth = {
  github: { enabled: true, failing: false },
  jira: { enabled: true, failing: false },
  slack: { enabled: true, failing: false },
}

function renderAlert(type: string, health: WatcherHealth) {
  vi.spyOn(api, "watcherHealth").mockResolvedValue(health)
  vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
  vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <SettingsProvider><WatcherAlert type={type} /></SettingsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("WatcherAlert", () => {
  it("says the watcher is disabled, and links to that service's settings", async () => {
    renderAlert("jira", { ...healthy, jira: { enabled: false, failing: false } })
    const alert = await screen.findByTestId("watcher-alert")
    expect(alert).toHaveTextContent("The Jira watcher is disabled. No new activity will appear. Re-enable it in settings")
    await userEvent.click(screen.getByRole("button", { name: "Re-enable it in settings" }))
    expect(await screen.findByRole("tab", { name: /^Jira/, selected: true })).toBeInTheDocument()
  })

  it("says authentication failed while every poll is failing", async () => {
    renderAlert("pr", { ...healthy, github: { enabled: true, failing: true, error: "401" } })
    expect(await screen.findByTestId("watcher-alert")).toHaveTextContent(
      "GitHub authentication failed. Check your internet connection or replace your token in settings")
    expect(screen.getByRole("button", { name: "replace your token in settings" })).toBeInTheDocument()
  })

  it("shows nothing for a healthy service or a link resource", async () => {
    renderAlert("slack", healthy)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("watcher-alert")).not.toBeInTheDocument()
    cleanup()
    renderAlert("link", { ...healthy, github: { enabled: false, failing: false } })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("watcher-alert")).not.toBeInTheDocument()
  })
})
