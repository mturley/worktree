import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { SessionInfo } from "../api/types"
import { DevicesModal } from "./DevicesModal"

const laptop: SessionInfo = { handle: "h-laptop", label: "Mac — Chrome", created_at: "2026-09-01T10:00:00Z", last_seen_at: "2026-09-15T10:00:00Z", current: true }
const phone: SessionInfo = { handle: "h-phone", label: "Android — Chrome", created_at: "2026-09-02T10:00:00Z", last_seen_at: "2026-09-14T10:00:00Z", current: false }

function reply(body: unknown, status = 200) {
  return { ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response
}

function renderModal(qc = new QueryClient()) {
  render(
    <QueryClientProvider client={qc}>
      <MantineProvider><DevicesModal opened onClose={() => {}} /></MantineProvider>
    </QueryClientProvider>,
  )
  return qc
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("DevicesModal", () => {
  it("lists every session and marks only the current one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply([laptop, phone])))
    renderModal()
    const rows = await screen.findAllByTestId("device-row")
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText("Mac — Chrome")).toBeInTheDocument()
    expect(within(rows[0]).getByText("This device")).toBeInTheDocument()
    expect(within(rows[1]).queryByText("This device")).not.toBeInTheDocument()
  })

  it("revokes another device by handle and refreshes the list", async () => {
    let sessions = [laptop, phone]
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/sessions/revoke") {
        sessions = [laptop]
        return reply({ ok: true })
      }
      return reply(sessions)
    })
    vi.stubGlobal("fetch", fetchMock)
    renderModal()
    await userEvent.click(await screen.findByRole("button", { name: "Log out Android — Chrome" }))
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/revoke", expect.objectContaining({
      body: JSON.stringify({ handle: "h-phone" }),
    }))
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(1))
  })

  it("revoking this device invalidates the session, which shows the login screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/sessions/revoke" ? reply({ ok: true }) : reply([laptop, phone]),
    ))
    const qc = new QueryClient()
    qc.setQueryData(["session"], laptop)
    renderModal(qc)
    await userEvent.click(await screen.findByRole("button", { name: "Log out Mac — Chrome" }))
    await waitFor(() => expect(qc.getQueryState(["session"])?.isInvalidated).toBe(true))
  })

  it("explains a failed revoke", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url === "/api/sessions/revoke" ? reply({ error: "no such session" }, 404) : reply([laptop, phone]),
    ))
    renderModal()
    await userEvent.click(await screen.findByRole("button", { name: "Log out Android — Chrome" }))
    expect(await screen.findByText("no such session")).toBeInTheDocument()
  })
})
