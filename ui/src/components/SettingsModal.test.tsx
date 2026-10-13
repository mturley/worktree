import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Settings } from "../api/types"
import { api } from "../api/client"
import { SettingsModal } from "./SettingsModal"

function renderModal(qc = new QueryClient()) {
  render(
    <QueryClientProvider client={qc}>
      <MantineProvider><SettingsModal opened onClose={() => {}} /></MantineProvider>
    </QueryClientProvider>,
  )
  return qc
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("SettingsModal", () => {
  it("has General and Devices tabs", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({ in_cmux: true, cmux_features_enabled: true })
    vi.spyOn(api, "sessions").mockResolvedValue([])
    renderModal()
    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "Devices" }))
    expect(await screen.findByText(/Every browser logged in/)).toBeInTheDocument()
  })

  it("reflects the server's cmux setting", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({ in_cmux: true, cmux_features_enabled: false })
    renderModal()
    const sw = await screen.findByLabelText(/^Enable cmux features/)
    await waitFor(() => expect(sw).not.toBeChecked())
    expect(sw).toBeEnabled()
  })

  it("greys the cmux toggle out when the server is not in cmux", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({ in_cmux: false, cmux_features_enabled: true })
    renderModal()
    const sw = await screen.findByLabelText(/^Enable cmux features/)
    await waitFor(() => expect(sw).toBeDisabled())
    await userEvent.hover(screen.getByText("Enable cmux features"))
    expect(await screen.findByText(/not running inside cmux/)).toBeInTheDocument()
  })

  it("saves a change and refreshes every cmux query", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({ in_cmux: true, cmux_features_enabled: true })
    const update = vi.spyOn(api, "updateSettings").mockResolvedValue(
      { in_cmux: true, cmux_features_enabled: false } satisfies Settings,
    )
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    renderModal(qc)
    const sw = await screen.findByLabelText(/^Enable cmux features/)
    await waitFor(() => expect(sw).toBeChecked())
    await userEvent.click(sw)
    await waitFor(() => expect(update).toHaveBeenCalledWith({ cmux_features_enabled: false }))
    await waitFor(() => expect(sw).not.toBeChecked())
    // One predicate-based invalidation covers ["cmux"], ["cmux-tree", path],
    // ["cmux-browser-tabs"], ["cmux-groups"], plus the session's notify_mode.
    const predicate = invalidate.mock.calls.map((c) => c[0]?.predicate).find(Boolean)
    expect(predicate).toBeDefined()
    const hits = (key: unknown[]) => predicate!({ queryKey: key } as never)
    expect(hits(["cmux"])).toBe(true)
    expect(hits(["cmux-tree", "/wt"])).toBe(true)
    expect(hits(["cmux-browser-tabs"])).toBe(true)
    expect(hits(["session"])).toBe(true)
    expect(hits(["worktrees"])).toBe(false)
  })

  it("shows an error when saving fails", async () => {
    vi.spyOn(api, "settings").mockResolvedValue({ in_cmux: true, cmux_features_enabled: true })
    vi.spyOn(api, "updateSettings").mockRejectedValue(new Error("disk full"))
    renderModal()
    await userEvent.click(await screen.findByLabelText(/^Enable cmux features/))
    expect(await screen.findByText(/disk full/)).toBeInTheDocument()
  })
})
