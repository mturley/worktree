import { afterEach, describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { ResourceCard } from "./ResourceCard"
import type { ResourceDTO } from "../api/types"

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
    wrap(<ResourceCard r={r} path="/some/worktree" onRemoved={onRemoved} variant="detail" />)

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
    wrap(<ResourceCard r={r} path="/some/worktree" onRemoved={onRemoved} variant="detail" />)

    await user.click(screen.getByRole("button", { name: "Remove resource" }))
    await screen.findByText("Remove this resource?")
    await user.click(screen.getByRole("button", { name: "Remove" }))

    expect(removeResource).toHaveBeenCalledWith({ path: "/some/worktree", type: "pr", id: "org/repo#1" })
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalled())
  })

  it("shows an error and keeps the popover open when removeResource fails", async () => {
    removeResource.mockRejectedValueOnce(new Error("failed to remove resource"))
    const onRemoved = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceCard r={r} path="/some/worktree" onRemoved={onRemoved} variant="detail" />)

    await user.click(screen.getByRole("button", { name: "Remove resource" }))
    await screen.findByText("Remove this resource?")
    await user.click(screen.getByRole("button", { name: "Remove" }))

    expect(await screen.findByText("failed to remove resource")).toBeInTheDocument()
    expect(screen.getByText("Remove this resource?")).toBeInTheDocument()
    expect(onRemoved).not.toHaveBeenCalled()
  })
})

describe("ResourceCard variants and selection", () => {
  const jira: ResourceDTO = {
    type: "jira", id: "J-1", url: "https://jira/browse/J-1", primary: true,
    title: "Investigate flux", status: "In Progress", labels: ["backend", "urgent"],
  } as ResourceDTO

  it("hides Jira labels in the compact variant", () => {
    wrap(<ResourceCard r={jira} />)
    expect(screen.queryByText("backend")).not.toBeInTheDocument()
  })

  it("shows Jira labels in the detail variant", () => {
    wrap(<ResourceCard r={jira} variant="detail" />)
    expect(screen.getByText("backend")).toBeInTheDocument()
    expect(screen.getByText("urgent")).toBeInTheDocument()
  })

  it("calls onSelect when a selectable card is clicked", async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceCard r={jira} onSelect={onSelect} />)
    await user.click(screen.getByRole("button", { name: /select resource J-1/i }))
    expect(onSelect).toHaveBeenCalled()
  })

  it("marks a selected card as pressed for assistive tech", () => {
    wrap(<ResourceCard r={jira} onSelect={() => {}} selected />)
    expect(screen.getByRole("button", { name: /select resource J-1/i })).toHaveAttribute("aria-pressed", "true")
  })

  it("puts no remove control on a selectable card, so removing cannot select", () => {
    // Phase C moved removal to the detail side. The old risk (clicking x also
    // selecting the card) is now structurally impossible rather than guarded:
    // the two controls never appear on the same card.
    const onSelect = vi.fn()
    wrap(<ResourceCard r={jira} onSelect={onSelect} />)
    expect(screen.queryByRole("button", { name: "Remove resource" })).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  // The "clicking a title link also selects the card" guard is gone: Phase C's
  // successor removed the link from compact cards entirely, so the hazard is
  // structurally impossible rather than guarded. See "renders no link in a
  // compact card" below, which pins that stronger invariant.
})

describe("ResourceCard interactive affordance", () => {
  const jiraCard: ResourceDTO = {
    type: "jira", id: "J-9", url: "https://jira/browse/J-9", primary: true,
    title: "Affordance check", status: "In Progress",
  } as ResourceDTO

  it("marks a selectable card as interactive so it gets the clickable surface + hover", () => {
    const { container } = wrap(<ResourceCard r={jiraCard} onSelect={() => {}} />)
    expect(container.querySelector('[data-interactive="true"]')).toBeInTheDocument()
  })

  it("does not mark a non-selectable card as interactive", () => {
    const { container } = wrap(<ResourceCard r={jiraCard} />)
    expect(container.querySelector('[data-interactive="true"]')).not.toBeInTheDocument()
  })
})

describe("ResourceCard remove control placement (phase C)", () => {
  const prCard: ResourceDTO = {
    type: "pr", id: "o/r#7", url: "https://gh/pr/7", primary: true,
    title: "Removable", state: "OPEN",
  } as ResourceDTO

  it("does not render a remove control on a selectable list card", () => {
    // With cards clickable-to-select, a per-card x is noise and an easy
    // mis-click; removal lives on the detail side instead.
    wrap(<ResourceCard r={prCard} path="/wt/foo" onSelect={() => {}} />)
    expect(screen.queryByRole("button", { name: "Remove resource" })).not.toBeInTheDocument()
  })

  it("does not render a remove control on a plain compact card", () => {
    wrap(<ResourceCard r={prCard} path="/wt/foo" />)
    expect(screen.queryByRole("button", { name: "Remove resource" })).not.toBeInTheDocument()
  })

  it("renders the remove control on the detail card", () => {
    wrap(<ResourceCard r={prCard} path="/wt/foo" variant="detail" />)
    expect(screen.getByRole("button", { name: "Remove resource" })).toBeInTheDocument()
  })
})

describe("ResourceCard link removal + detail actions", () => {
  const pr: ResourceDTO = {
    type: "pr", id: "o/r#5", url: "https://gh/pr/5", primary: true,
    title: "Clickable check", state: "OPEN",
  } as ResourceDTO

  it("renders no link in a compact card, so the whole card is one click target", () => {
    // The title used to be an anchor: easy to hit by accident when you meant
    // to select the card.
    wrap(<ResourceCard r={pr} onSelect={() => {}} />)
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.getByText("Clickable check")).toBeInTheDocument()
  })

  it("offers Open in / copy on the detail card instead", () => {
    wrap(<ResourceCard r={pr} variant="detail" />)
    expect(screen.getByRole("link", { name: "Open in GitHub" })).toHaveAttribute("href", "https://gh/pr/5")
    expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument()
  })
})
