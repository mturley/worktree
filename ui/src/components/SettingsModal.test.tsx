import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { SettingsModal } from "./SettingsModal"
import { baseSettings } from "./settings/testSettings"

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
  it("has the four tabs and the persisted-to line", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    for (const name of ["General", "Watcher Auth", "Watcher Config", "Devices"]) {
      expect(screen.getByRole("tab", { name: new RegExp(name) })).toBeInTheDocument()
    }
    expect(await screen.findByText(/These settings are persisted to/)).toHaveTextContent("~/.config/worktree/config.yaml")
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

  it("marks a tab with unsaved changes", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    await userEvent.type(await screen.findByLabelText("Editor"), "zed")
    expect(screen.getByRole("tab", { name: /General/ })).toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /Watcher Auth/ })).not.toHaveTextContent("●")
  })

  it("shows a save error on its tab and keeps the change", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "saveWorktreeSettings").mockRejectedValue(new Error("disk full"))
    renderModal()
    await userEvent.type(await screen.findByLabelText("Editor"), "zed")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText("disk full")).toBeInTheDocument()
    expect(screen.getByLabelText("Editor")).toHaveValue("zed")
  })
})
