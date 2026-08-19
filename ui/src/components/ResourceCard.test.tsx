import { afterEach, describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { ResourceCard } from "./ResourceCard"

const removeResource = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api, removeResource: (...args: unknown[]) => removeResource(...args) } }
})

afterEach(() => {
  removeResource.mockReset()
})

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

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

describe("ResourceCard slack", () => {
  it("shows custom_name when set", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false, custom_name: "Release blocker" } as any} />)
    expect(screen.getByText("Release blocker")).toBeInTheDocument()
    expect(screen.queryByText("C1:170.100")).not.toBeInTheDocument()
  })

  it("falls back to title when no custom_name", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false, title: "e2e regression thread" } as any} />)
    expect(screen.getByText("e2e regression thread")).toBeInTheDocument()
  })

  it("falls back to id when no custom_name or title", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false } as any} />)
    expect(screen.getByText("C1:170.100")).toBeInTheDocument()
  })

  it("shows #channel_name when set", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false, channel_name: "wg-dashboard-zaffre" } as any} />)
    expect(screen.getByText("#wg-dashboard-zaffre")).toBeInTheDocument()
  })

  it("shows by <author> when set", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false, author: "Christian Vogt" } as any} />)
    expect(screen.getByText("by Christian Vogt")).toBeInTheDocument()
  })

  it("shows started/active relative times when created_ts/updated_ts are set", () => {
    const nowSec = Math.floor(Date.now() / 1000)
    wrap(<ResourceCard r={{
      type: "slack", id: "C1:170.100", url: "https://x", primary: false,
      created_ts: String(nowSec - 3600), updated_ts: String(nowSec - 60),
    } as any} />)
    expect(screen.getByText(/^started /)).toBeInTheDocument()
    expect(screen.getByText(/^· active /)).toBeInTheDocument()
  })
})

describe("ResourceCard remove control", () => {
  const r = { type: "pr", id: "org/repo#1", url: "https://x", primary: false } as any

  it("opens a confirm popover and does not call removeResource on cancel", async () => {
    removeResource.mockResolvedValueOnce(null)
    const onRemoved = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceCard r={r} path="/some/worktree" onRemoved={onRemoved} />)

    await user.click(screen.getByRole("button", { name: "Remove resource" }))
    expect(await screen.findByText("Remove this resource?")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(removeResource).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it("calls api.removeResource with {path, type, id} and onRemoved on confirm", async () => {
    removeResource.mockResolvedValueOnce(null)
    const onRemoved = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceCard r={r} path="/some/worktree" onRemoved={onRemoved} />)

    await user.click(screen.getByRole("button", { name: "Remove resource" }))
    await screen.findByText("Remove this resource?")
    await user.click(screen.getByRole("button", { name: "Remove" }))

    expect(removeResource).toHaveBeenCalledWith({ path: "/some/worktree", type: "pr", id: "org/repo#1" })
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalled())
  })
})
