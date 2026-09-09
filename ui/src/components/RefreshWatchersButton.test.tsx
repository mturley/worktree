import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RefreshWatchersButton } from "./RefreshWatchersButton"
import type { WatchersResponse } from "../api/types"

const watchers = vi.fn<() => Promise<WatchersResponse>>()
const pollWatchers = vi.fn<() => Promise<null>>()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api, watchers: () => watchers(), pollWatchers: () => pollWatchers() } }
})

const wrap = () =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RefreshWatchersButton />
      </QueryClientProvider>
    </MantineProvider>,
  )

const button = () => screen.getByRole("button", { name: "Refresh watchers" })

beforeEach(() => {
  watchers.mockResolvedValue({ watchers: [], polling: false })
  pollWatchers.mockResolvedValue(null)
})
afterEach(() => { cleanup(); watchers.mockReset(); pollWatchers.mockReset() })

describe("RefreshWatchersButton", () => {
  it("asks the server to refresh all three watchers", async () => {
    wrap()
    await waitFor(() => expect(button()).toBeEnabled())
    await userEvent.click(button())
    expect(pollWatchers).toHaveBeenCalledTimes(1)
  })

  it("spins and disables while a poll is in flight", async () => {
    watchers.mockResolvedValue({ watchers: [], polling: true })
    wrap()
    await waitFor(() => expect(button()).toBeDisabled())
    expect(button()).toHaveAttribute("aria-busy", "true")
    const icon = button().querySelector("svg") as SVGElement
    expect(icon.style.animation).toContain("wt-spin")
  })

  it("spins for the BACKGROUND loop's polls, not only ones the user started", async () => {
    // The honest reading of "is anything fetching right now" — and what lets
    // you tell a quiet feed from a stalled one.
    watchers.mockResolvedValue({ watchers: [], polling: true })
    wrap()
    await waitFor(() => expect(button()).toBeDisabled())
    expect(pollWatchers).not.toHaveBeenCalled()
  })

  it("is still and enabled when nothing is polling", async () => {
    wrap()
    await waitFor(() => expect(button()).toBeEnabled())
    const icon = button().querySelector("svg") as SVGElement
    expect(icon.style.animation).toBe("")
  })

  it("does not offer a second request while one is running", async () => {
    watchers.mockResolvedValue({ watchers: [], polling: true })
    wrap()
    await waitFor(() => expect(button()).toBeDisabled())
    await userEvent.click(button(), { pointerEventsCheck: 0 })
    expect(pollWatchers).not.toHaveBeenCalled()
  })
})
