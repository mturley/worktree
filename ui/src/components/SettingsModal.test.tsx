import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { SettingsModal } from "./SettingsModal"
import { baseSettings, DEFAULT_CMD } from "./settings/testSettings"

/** Open Connected Services and one of its sub-tabs. */
async function openService(name: "GitHub" | "Jira" | "Slack") {
  await userEvent.click(screen.getByRole("tab", { name: /Connected Services/ }))
  await userEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }))
}

function renderModal(qc = new QueryClient(), onClose = () => {}) {
  render(
    <QueryClientProvider client={qc}>
      <MantineProvider><SettingsModal opened onClose={onClose} /></MantineProvider>
    </QueryClientProvider>,
  )
  return qc
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("SettingsModal", () => {
  it("has the top-level tabs and the persisted-to line", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    for (const name of ["General", "Connected Services", "UI Access", "Devices", "Logs"]) {
      expect(screen.getByRole("tab", { name: new RegExp(name) })).toBeInTheDocument()
    }
    // Every config tab is mounted, each with its own line; General is first.
    expect((await screen.findAllByText(/These settings are persisted to/))[0]).toHaveTextContent("~/.config/worktree/config.yaml")
  })

  it("Logs: fetches nothing until opened, then shows the watcher log and resource status sub-tabs", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const log = vi.spyOn(api, "watcherLog").mockResolvedValue({ entries: [], has_more: false })
    const resources = vi.spyOn(api, "watchedResources").mockResolvedValue({ resources: [] })
    renderModal()
    await screen.findAllByText(/These settings are persisted to/)
    expect(log).not.toHaveBeenCalled()
    expect(resources).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("tab", { name: "Logs" }))
    expect(await screen.findByText("No watcher activity recorded yet.")).toBeInTheDocument()
    expect(resources).not.toHaveBeenCalled()
    // Read-only: no Save/Discard footer.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    await userEvent.click(screen.getByRole("tab", { name: "Resource status" }))
    expect(await screen.findByText("No resources are being watched.")).toBeInTheDocument()
    expect(resources).toHaveBeenCalled()
  })

  it("does not save the cmux toggle until Save, then refreshes cmux queries", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const after = baseSettings()
    after.worktree.cmux_features_enabled = false
    const save = vi.spyOn(api, "saveWorktreeSettings").mockResolvedValue(after)
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    renderModal(qc)
    await userEvent.click(await screen.findByLabelText(/^Enable cmux features/))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0][0].cmux_features_enabled).toBe(false)
    const predicate = invalidate.mock.calls.map((c) => c[0]?.predicate).find(Boolean)
    expect(predicate!({ queryKey: ["cmux-tree", "/wt"] } as never)).toBe(true)
    expect(predicate!({ queryKey: ["session"] } as never)).toBe(true)
    expect(predicate!({ queryKey: ["worktrees"] } as never)).toBe(false)
  })

  it("greys the cmux toggle out when the server is not in cmux", async () => {
    const s = baseSettings()
    s.environment.in_cmux = false
    vi.spyOn(api, "settings").mockResolvedValue(s)
    renderModal()
    await waitFor(async () => expect(await screen.findByLabelText(/^Enable cmux features/)).toBeDisabled())
  })

  it("shows a restart badge and counts restart changes", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    expect(await screen.findByText("Applies after restarting worktree ui")).toBeInTheDocument()
    const port = screen.getByLabelText("HTTPS port")
    await userEvent.clear(port)
    await userEvent.type(port, "9000")
    expect(screen.getByText(/1 needs a restart/)).toBeInTheDocument()
  })

  it("warns when an allowed host is not in the certificate", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    await userEvent.click(screen.getByRole("tab", { name: /UI Access/ }))
    const hosts = await screen.findByRole("textbox", { name: "Allowed hosts" })
    await userEvent.type(hosts, "10.0.0.5{enter}")
    expect(screen.getByText(/doesn't cover/)).toHaveTextContent("10.0.0.5")
  })

  it("Discard restores the saved values", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    const editor = await screen.findByLabelText("Editor")
    await userEvent.type(editor, "zed")
    await userEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(editor).toHaveValue("")
    expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument()
  })

  it("asks before closing with unsaved changes", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const onClose = vi.fn()
    renderModal(new QueryClient(), onClose)
    await userEvent.type(await screen.findByLabelText("Editor"), "zed")
    await userEvent.keyboard("{Escape}")
    expect(onClose).not.toHaveBeenCalled()
    const confirm = screen.getByRole("alert")
    await userEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }))
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard("{Escape}")
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Discard and close" }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("adopts fresh server values after close and reopen", async () => {
    const spy = vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const qc = new QueryClient()
    const ui = (opened: boolean) => (
      <QueryClientProvider client={qc}>
        <MantineProvider><SettingsModal opened={opened} onClose={() => {}} /></MantineProvider>
      </QueryClientProvider>
    )
    const { rerender } = render(ui(true))
    expect(await screen.findByLabelText("Editor")).toHaveValue("")
    rerender(ui(false))
    const edited = baseSettings()
    edited.worktree.editor = "zed"
    spy.mockResolvedValue(edited)
    rerender(ui(true))
    await waitFor(() => expect(screen.getByLabelText("Editor")).toHaveValue("zed"))
    expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument()
  })

  it("keeps the form when a background refetch fails", async () => {
    const spy = vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const qc = renderModal(new QueryClient({ defaultOptions: { queries: { retry: false } } }))
    await screen.findByLabelText("Editor")
    spy.mockRejectedValue(new Error("boom"))
    await qc.refetchQueries({ queryKey: ["settings"] })
    expect(screen.getByLabelText("Editor")).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load settings")).not.toBeInTheDocument()
  })

  it("disables every field while a save is in flight", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    let finish: (s: ReturnType<typeof baseSettings>) => void = () => {}
    vi.spyOn(api, "saveWorktreeSettings").mockImplementation(() => new Promise((r) => { finish = r }))
    renderModal()
    const editor = await screen.findByLabelText("Editor")
    await userEvent.type(editor, "zed")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(editor).toBeDisabled())
    expect(screen.getByLabelText("UI password")).toBeDisabled()
    expect(screen.getByRole("tab", { name: /Connected Services/ })).toBeEnabled()
    const saved = baseSettings()
    saved.worktree.editor = "zed"
    finish(saved)
    await waitFor(() => expect(editor).toBeEnabled())
  })

  it("marks a tab with unsaved changes", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    await userEvent.type(await screen.findByLabelText("Editor"), "zed")
    expect(screen.getByRole("tab", { name: /General/ })).toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /Connected Services/ })).not.toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /UI Access/ })).not.toHaveTextContent("●")
  })

  it("marks UI Access, not General, for a ui.* change, though both are config.yaml", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    await userEvent.click(screen.getByRole("tab", { name: /UI Access/ }))
    const hosts = await screen.findByRole("textbox", { name: "Allowed hosts" })
    await userEvent.type(hosts, "box.local{Enter}")
    expect(screen.getByRole("tab", { name: /UI Access/ })).toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /General/ })).not.toHaveTextContent("●")
  })

  it("Notifications: the global switch greys out the custom command and marks only its tab dirty", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    await userEvent.click(await screen.findByRole("tab", { name: /Notifications/ }))
    const custom = await screen.findByLabelText(/^Trigger custom command for each notification/)
    const command = screen.getByLabelText(/^Command/)
    expect(custom).not.toBeDisabled()
    // The custom command defaults to off, so its input is disabled.
    expect(command).toBeDisabled()
    await userEvent.click(custom)
    expect(command).not.toBeDisabled()
    expect(command).toHaveValue(DEFAULT_CMD)
    expect(screen.getByRole("tab", { name: /Notifications/ })).toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /General/ })).not.toHaveTextContent("●")

    await userEvent.click(screen.getByLabelText(/^Enable notifications/))
    // Re-queried: the disabled switch gains a tooltip wrapper, remounting it.
    expect(screen.getByLabelText(/^Trigger custom command for each notification/)).toBeDisabled()
    expect(screen.getByLabelText(/^Command/)).toBeDisabled()
  })

  it("Notifications: Reset to default restores the default command", async () => {
    const s = baseSettings()
    s.worktree.notifications = { enabled: true, command_enabled: true, command: "echo hi" }
    vi.spyOn(api, "settings").mockResolvedValue(s)
    renderModal()
    await userEvent.click(await screen.findByRole("tab", { name: /Notifications/ }))
    expect(await screen.findByLabelText(/^Command/)).toHaveValue("echo hi")
    await userEvent.click(screen.getByRole("button", { name: "Reset to default" }))
    expect(screen.getByLabelText(/^Command/)).toHaveValue(DEFAULT_CMD)
  })

  it("shows a save error on its tab and keeps the change", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "saveWorktreeSettings").mockRejectedValue(new Error("disk full"))
    renderModal()
    await userEvent.type(await screen.findByLabelText("Editor"), "zed")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    // General, Notifications, UI Access and all three service sub-tabs
    // (their watcher toggles) edit config.yaml, so all show its error.
    expect(await screen.findAllByText("disk full")).toHaveLength(6)
    expect(screen.getByLabelText("Editor")).toHaveValue("zed")
  })

  it("Connected Services: tests configured services on open and never renders secrets", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const test = vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    renderModal()
    await openService("GitHub")
    await waitFor(() => expect(test).toHaveBeenCalledTimes(3))
    expect(test).toHaveBeenCalledWith("jira", { host: "https://x.atlassian.net", email: "me@x" })
    expect(screen.getByText(/To automatically capture/)).toHaveTextContent("run worktree setup slack.")
    expect(screen.queryByText(/agent-handler/i)).not.toBeInTheDocument()
  })

  it("Connected Services: a Jira replace tests with the form's host and email, and Save writes it", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const test = vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    const replace = vi.spyOn(api, "replaceCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    vi.spyOn(api, "saveWatcherAuthSettings").mockResolvedValue(baseSettings())
    renderModal()
    await openService("Jira")
    const email = await screen.findByLabelText("Email")
    await userEvent.clear(email)
    await userEvent.type(email, "new@x")
    await userEvent.type(screen.getByLabelText("API token"), "tok")
    await userEvent.click(screen.getByRole("button", { name: "Replace" }))
    await waitFor(() => expect(test).toHaveBeenCalledWith("jira", { token: "tok", host: "https://x.atlassian.net", email: "new@x" }))
    expect(replace).not.toHaveBeenCalled()
    expect(await screen.findByText("Unsaved")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Revert" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith("jira", { token: "tok", host: "https://x.atlassian.net", email: "new@x" }))
    await waitFor(() => expect(screen.queryByText("Unsaved")).not.toBeInTheDocument())
  })

  it("Connected Services: a refused candidate is not held", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "testCredential").mockResolvedValue({ ok: false, kind: "auth", detail: "401 Bad credentials" })
    renderModal()
    await openService("GitHub")
    await userEvent.type(await screen.findByLabelText("Token"), "bad{Enter}")
    expect(await screen.findByText(/The new value was not kept/)).toBeInTheDocument()
    expect(screen.queryByText("Unsaved")).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Connected Services/ })).not.toHaveTextContent("●")
  })

  it("Connected Services: Revert and Discard drop a pending secret without writing it", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    const replace = vi.spyOn(api, "replaceCredential")
    renderModal()
    await openService("GitHub")
    await userEvent.type(await screen.findByLabelText("Token"), "ghp_new{Enter}")
    expect(await screen.findByText("Unsaved")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /Connected Services/ })).toHaveTextContent("●")
    await userEvent.click(screen.getByRole("button", { name: "Revert" }))
    expect(screen.queryByText("Unsaved")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    await userEvent.type(screen.getByLabelText("Token"), "ghp_new{Enter}")
    expect(await screen.findByText("Unsaved")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(screen.queryByText("Unsaved")).not.toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it("Connected Services: a credential refused at Save stays pending with its error", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    vi.spyOn(api, "replaceCredential").mockResolvedValue({ ok: false, kind: "auth", detail: "token revoked" })
    renderModal()
    await openService("GitHub")
    await userEvent.type(await screen.findByLabelText("Token"), "ghp_new{Enter}")
    expect(await screen.findByText("Unsaved")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    // auth.yaml backs all three sub-tabs, so each shows its error.
    expect(await screen.findAllByText(/GitHub token: token revoked. It was not saved./)).toHaveLength(3)
    expect(screen.getByText("Unsaved")).toBeInTheDocument()
  })

  it("Connected Services → Jira: edits custom fields and saves the map", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const save = vi.spyOn(api, "saveWatcherConfigSettings").mockResolvedValue(baseSettings())
    renderModal()
    await openService("Jira")
    await userEvent.click(await screen.findByRole("button", { name: "Remove field 1" }))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0][0].jira.custom_fields).toEqual({ b: "customfield_2" })
  })

  it("Escape in an editing secret cancels the edit without closing; idle Escape closes", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const onClose = vi.fn()
    renderModal(new QueryClient(), onClose)
    const pw = await screen.findByLabelText("UI password")
    await userEvent.click(pw)
    await userEvent.type(pw, "abc")
    await userEvent.keyboard("{Escape}")
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByLabelText("UI password")).toHaveValue("")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it("typing after Escape re-enters editing", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    await userEvent.click(screen.getByRole("tab", { name: /UI Access/ }))
    const pw = await screen.findByLabelText("UI password")
    await userEvent.click(pw)
    await userEvent.type(pw, "abc")
    await userEvent.keyboard("{Escape}")
    await userEvent.type(screen.getByLabelText("UI password"), "x")
    expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("Enter during an in-flight replace test does not submit twice", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    let resolve: (r: { ok: boolean; kind: "ok"; detail: string }) => void = () => {}
    const test = vi.spyOn(api, "testCredential").mockImplementation((_svc, o) =>
      o?.token === "abc" ? new Promise((r) => { resolve = r }) : Promise.resolve({ ok: true, kind: "ok", detail: "" }))
    renderModal()
    await openService("GitHub")
    await userEvent.type(await screen.findByLabelText("Token"), "abc{Enter}{Enter}")
    expect(test.mock.calls.filter(([, o]) => o?.token === "abc")).toHaveLength(1)
    resolve({ ok: true, kind: "ok", detail: "" })
    expect(await screen.findByText("Unsaved")).toBeInTheDocument()
  })

  it("UI password waits for Save, then refetches settings", async () => {
    const get = vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const replace = vi.spyOn(api, "replacePassword").mockResolvedValue(undefined as never)
    renderModal()
    await userEvent.click(screen.getByRole("tab", { name: /UI Access/ }))
    await userEvent.type(await screen.findByLabelText("UI password"), "pw{Enter}")
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByRole("tab", { name: /UI Access/ })).toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /General/ })).not.toHaveTextContent("●")
    const gets = get.mock.calls.length
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith("pw"))
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(gets))
    await waitFor(() => expect(screen.getByRole("tab", { name: /UI Access/ })).not.toHaveTextContent("●"))
  })

  it("Connected Services: a Slack cookie-only replace tests and saves only the cookie", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const test = vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    const replace = vi.spyOn(api, "replaceCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    renderModal()
    await openService("Slack")
    await userEvent.type(await screen.findByLabelText("Session cookie"), "xoxd-new")
    await userEvent.click(screen.getByRole("button", { name: "Replace" }))
    await waitFor(() => expect(test).toHaveBeenCalledWith("slack", { cookie: "xoxd-new" }))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith("slack", { cookie: "xoxd-new" }))
  })

  it("a stale in-flight refetch cannot revert a saved field", async () => {
    const spy = vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const saved = baseSettings()
    saved.worktree.editor = "zed"
    vi.spyOn(api, "saveWorktreeSettings").mockResolvedValue(saved)
    const qc = renderModal()
    const editor = await screen.findByLabelText("Editor")
    await userEvent.type(editor, "zed")
    let release: (s: ReturnType<typeof baseSettings>) => void = () => {}
    spy.mockReturnValue(new Promise((r) => { release = r }))
    void qc.refetchQueries({ queryKey: ["settings"] })
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument())
    release(baseSettings()) // the old values land after the save
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByLabelText("Editor")).toHaveValue("zed")
  })

  it("Connected Services: warns when the Jira host changes while a token is stored", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    renderModal()
    await openService("Jira")
    const host = await screen.findByLabelText("Host")
    expect(screen.queryByText(/Changing the host needs the API token/)).not.toBeInTheDocument()
    await userEvent.type(host, "2")
    expect(screen.getByText("Changing the host needs the API token: paste it below and press Replace, then Save.")).toBeInTheDocument()
  })

  it("Connected Services → Jira: a duplicate custom field name shows an error and blocks the save", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const save = vi.spyOn(api, "saveWatcherConfigSettings").mockResolvedValue(baseSettings())
    renderModal()
    await openService("Jira")
    const second = await screen.findByLabelText("Field 2 name")
    await userEvent.clear(second)
    await userEvent.type(second, "a")
    expect(screen.getByText(/Duplicate name "a"/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText("Field 2 ID"), "x")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(save).not.toHaveBeenCalled()
    expect(await screen.findByText(/Couldn't save watcher config.yaml/)).toBeInTheDocument()
  })

  it("General: clearing the HTTPS port maps to the default 8476", async () => {
    const start = baseSettings()
    start.worktree.ui.https_port = 9000
    vi.spyOn(api, "settings").mockResolvedValue(start)
    const save = vi.spyOn(api, "saveWorktreeSettings").mockResolvedValue(start)
    renderModal()
    const port = await screen.findByLabelText("HTTPS port")
    await userEvent.clear(port)
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0][0].ui.https_port).toBe(8476)
  })

  it("UI Access: turning remote access off greys out its fields and saves", async () => {
    const start = baseSettings()
    vi.spyOn(api, "settings").mockResolvedValue(start)
    const save = vi.spyOn(api, "saveWorktreeSettings").mockResolvedValue(start)
    renderModal()
    await userEvent.click(await screen.findByRole("tab", { name: /UI Access/ }))
    const toggle = await screen.findByLabelText(/^Enable remote access/)
    expect(screen.getByLabelText("HTTPS port")).toBeEnabled()
    await userEvent.click(toggle)
    for (const label of ["HTTPS port", "TLS certificate", "TLS key"]) {
      expect(screen.getByLabelText(label)).toBeDisabled()
    }
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0][0].ui.remote_access_enabled).toBe(false)
  })
})

describe("SettingsModal tab dots", () => {
  it("marks only the Jira sub-tab for a Jira project key, and Connected Services, not General", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    await openService("Jira")
    await userEvent.type(screen.getByRole("textbox", { name: "Project keys" }), "XYZ{Enter}")
    expect(screen.getByRole("tab", { name: /^Jira/ })).toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /^GitHub/ })).not.toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /^Slack/ })).not.toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /Connected Services/ })).toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /General/ })).not.toHaveTextContent("●")
  })

  it("the Jira sub-tab names all three files it saves to", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    await openService("Jira")
    const line = screen.getAllByText(/These settings are persisted to/).find((el) => el.textContent?.includes("watcher/config.yaml"))
    expect(line).toHaveTextContent("~/.config/worktree/config.yaml, ~/.config/watcher/auth.yaml and ~/.config/watcher/config.yaml")
  })
})
