import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { SettingsModal } from "./SettingsModal"
import type { SettingsTarget } from "./settings/SettingsContext"
import { baseSettings } from "./settings/testSettings"

function renderModal(target?: SettingsTarget) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider><SettingsModal opened onClose={() => {}} target={target} /></MantineProvider>
    </QueryClientProvider>,
  )
}

async function openService(name: "GitHub" | "Jira" | "Slack") {
  await userEvent.click(screen.getByRole("tab", { name: /Connected Services/ }))
  await userEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("SettingsModal watcher toggles", () => {
  it("turning a watcher off explains it, disables its credentials, marks its sub-tab and saves", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    const save = vi.spyOn(api, "saveWorktreeSettings").mockResolvedValue(baseSettings())
    renderModal()
    await openService("GitHub")
    await userEvent.click(screen.getByLabelText(/^Enable GitHub watcher/))
    expect(screen.getByText("Existing GitHub resources will still appear, but worktree will not connect to GitHub. No new activity will appear and linked resources will not update.")).toBeInTheDocument()
    expect(screen.getByLabelText("Token")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled()
    expect(screen.getByRole("tab", { name: /^GitHub/ })).toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /General/ })).not.toHaveTextContent("●")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0][0].watchers).toEqual({ github: false, jira: true, slack: true })
  })

  it("Slack's help text names threads", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    renderModal()
    await openService("Slack")
    await userEvent.click(screen.getByLabelText(/^Enable Slack watcher/))
    expect(screen.getByText(/No new activity will appear and threads will not be interactable\./)).toBeInTheDocument()
  })

  it("doesn't auto-test a service whose saved watcher is off", async () => {
    const s = baseSettings()
    s.worktree.watchers.jira = false
    vi.spyOn(api, "settings").mockResolvedValue(s)
    const test = vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    renderModal()
    await userEvent.click(screen.getByRole("tab", { name: /Connected Services/ }))
    await waitFor(() => expect(test).toHaveBeenCalledTimes(2))
    expect(test.mock.calls.map(([svc]) => svc).sort()).toEqual(["github", "slack"])
  })

  it("a held secret for a watcher turned off is not sent at Save", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    vi.spyOn(api, "saveWorktreeSettings").mockResolvedValue(baseSettings())
    const replace = vi.spyOn(api, "replaceCredential")
    renderModal()
    await openService("GitHub")
    await userEvent.type(screen.getByLabelText("Token"), "ghp_new{Enter}")
    expect(await screen.findByText("Unsaved")).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText(/^Enable GitHub watcher/))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect((await screen.findAllByText(/GitHub token: turn the GitHub watcher on to save it\./)).length).toBeGreaterThan(0)
    expect(replace).not.toHaveBeenCalled()
  })

  it("opens at a target tab and service", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    renderModal({ tab: "connected", service: "slack" })
    expect(await screen.findByRole("tab", { name: /^Slack/, selected: true })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Connected Services/, selected: true })).toBeInTheDocument()
  })
})
