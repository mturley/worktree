import { afterEach, describe, it, expect, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { ResourceCard } from "./ResourceCard"
import type { ResourceDTO } from "../api/types"

const removeResource = vi.fn()
const setResourcePrimary = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      removeResource: (...args: unknown[]) => removeResource(...args),
      setResourcePrimary: (...args: unknown[]) => setResourcePrimary(...args),
    },
  }
})

afterEach(() => {
  removeResource.mockReset()
  setResourcePrimary.mockReset()
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

    await user.click(screen.getByRole("button", { name: "Unfollow resource" }))
    expect(await screen.findByText("Unfollow this resource?")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(removeResource).not.toHaveBeenCalled()
    expect(onRemoved).not.toHaveBeenCalled()
  })

  it("calls api.removeResource with {path, type, id} and onRemoved on confirm", async () => {
    removeResource.mockResolvedValueOnce(null)
    const onRemoved = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceCard r={r} path="/some/worktree" onRemoved={onRemoved} variant="detail" />)

    await user.click(screen.getByRole("button", { name: "Unfollow resource" }))
    await screen.findByText("Unfollow this resource?")
    await user.click(screen.getByRole("button", { name: "Unfollow" }))

    expect(removeResource).toHaveBeenCalledWith({ path: "/some/worktree", type: "pr", id: "org/repo#1" })
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalled())
  })

  it("shows an error and keeps the popover open when removeResource fails", async () => {
    removeResource.mockRejectedValueOnce(new Error("failed to remove resource"))
    const onRemoved = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceCard r={r} path="/some/worktree" onRemoved={onRemoved} variant="detail" />)

    await user.click(screen.getByRole("button", { name: "Unfollow resource" }))
    await screen.findByText("Unfollow this resource?")
    await user.click(screen.getByRole("button", { name: "Unfollow" }))

    expect(await screen.findByText("failed to remove resource")).toBeInTheDocument()
    expect(screen.getByText("Unfollow this resource?")).toBeInTheDocument()
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
    expect(screen.queryByRole("button", { name: "Unfollow resource" })).not.toBeInTheDocument()
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
    expect(screen.queryByRole("button", { name: "Unfollow resource" })).not.toBeInTheDocument()
  })

  it("does not render a remove control on a plain compact card", () => {
    wrap(<ResourceCard r={prCard} path="/wt/foo" />)
    expect(screen.queryByRole("button", { name: "Unfollow resource" })).not.toBeInTheDocument()
  })

  it("renders the remove control on the detail card", () => {
    wrap(<ResourceCard r={prCard} path="/wt/foo" variant="detail" />)
    expect(screen.getByRole("button", { name: "Unfollow resource" })).toBeInTheDocument()
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
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", "https://gh/pr/5")
    expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument()
  })
})

describe("ResourceCard focus/related control (phase E)", () => {
  const related: ResourceDTO = {
    type: "pr", id: "o/r#9", url: "https://gh/pr/9", primary: false,
    title: "Reclassify me", state: "OPEN",
  } as ResourceDTO

  it("shows the current classification", () => {
    wrap(<ResourceCard r={related} path="/wt" variant="detail" />)
    expect(screen.getByRole("radio", { name: "Related" })).toBeChecked()
  })

  it("writes straight through on change, with no confirm step", async () => {
    setResourcePrimary.mockResolvedValueOnce(null)
    const onMetaChanged = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceCard r={related} path="/wt" variant="detail" onMetaChanged={onMetaChanged} />)
    await user.click(screen.getByRole("radio", { name: "Focus" }))
    await waitFor(() =>
      expect(setResourcePrimary).toHaveBeenCalledWith({
        path: "/wt", type: "pr", id: "o/r#9", primary: true,
      }),
    )
    // Refetch, so the Focus/Related sections in the list re-sort immediately.
    await waitFor(() => expect(onMetaChanged).toHaveBeenCalled())
  })

  it("surfaces a failure instead of silently reverting", async () => {
    setResourcePrimary.mockRejectedValueOnce(new Error("HTTP 500"))
    const user = userEvent.setup()
    wrap(<ResourceCard r={related} path="/wt" variant="detail" />)
    await user.click(screen.getByRole("radio", { name: "Focus" }))
    expect(await screen.findByText("HTTP 500")).toBeInTheDocument()
  })

  it("is absent from list cards, which are for selecting", () => {
    wrap(<ResourceCard r={related} path="/wt" onSelect={() => {}} />)
    expect(screen.queryByRole("radio", { name: "Focus" })).not.toBeInTheDocument()
  })
})

describe("ResourceCard status icons", () => {
  it("shows the status icon beside the title, matching the worktree card", () => {
    const merged = { type: "pr", id: "o/r#3", url: "u", primary: true, title: "Shipped", state: "MERGED" } as ResourceDTO
    wrap(<ResourceCard r={merged} onSelect={() => {}} />)
    // Same accessible label the worktree card's focus lines use, because both
    // read the one resourceStatusMeta mapping.
    expect(screen.getByLabelText("merged")).toBeInTheDocument()
    expect(screen.getByText("Shipped")).toBeInTheDocument()
  })
})

describe("edit custom details button", () => {
  const pr = (o: Partial<ResourceDTO> = {}): ResourceDTO =>
    ({ type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", ...o }) as ResourceDTO

  it("says Add when nothing custom is set, Edit once it is", () => {
    const { unmount } = wrap(<ResourceCard r={pr()} path="/wt" variant="detail" />)
    expect(screen.getByRole("button", { name: /add custom description/i })).toBeInTheDocument()
    unmount()
    wrap(<ResourceCard r={pr({ custom_description: "why this matters" })} path="/wt" variant="detail" />)
    expect(screen.getByRole("button", { name: /edit custom description/i })).toBeInTheDocument()
  })

  it("offers only a description for PR and Jira, name too for Slack", () => {
    // A PR or Jira issue takes its title from the source; only a Slack thread
    // has a custom name to set, so the label must not promise one.
    const { unmount } = wrap(<ResourceCard r={pr()} path="/wt" variant="detail" />)
    expect(screen.queryByRole("button", { name: /custom name/i })).not.toBeInTheDocument()
    unmount()
    const slack = { type: "slack", id: "C1:1.2", url: "u", primary: false, title: "Deploy thread" } as ResourceDTO
    wrap(<ResourceCard r={slack} path="/wt" variant="detail" />)
    expect(screen.getByRole("button", { name: /add custom name\/description/i })).toBeInTheDocument()
  })

  it("counts a Slack custom name as something to edit", () => {
    const slack = { type: "slack", id: "C1:1.2", url: "u", primary: false, custom_name: "Deploys" } as ResourceDTO
    wrap(<ResourceCard r={slack} path="/wt" variant="detail" />)
    expect(screen.getByRole("button", { name: /edit custom name\/description/i })).toBeInTheDocument()
  })

  it("opens the edit modal", async () => {
    const user = userEvent.setup()
    wrap(<ResourceCard r={pr()} path="/wt" variant="detail" />)
    await user.click(screen.getByRole("button", { name: /add custom description/i }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("is absent on list cards, which are click-to-select", () => {
    wrap(<ResourceCard r={pr()} path="/wt" onSelect={() => {}} />)
    expect(screen.queryByRole("button", { name: /custom description/i })).not.toBeInTheDocument()
  })
})

describe("custom description prominence", () => {
  it("renders larger than the fetched metadata around it", () => {
    // It is the one line a person wrote about why this resource matters, so
    // it should not be the smallest, dimmest text on the card.
    const r = {
      type: "pr", id: "o/r#1", url: "u", primary: true, title: "Fix the widget",
      author: "octocat", custom_description: "blocks the release",
    } as ResourceDTO
    wrap(<ResourceCard r={r} path="/wt" variant="detail" />)
    const note = screen.getByText("blocks the release")
    const meta = screen.getByText(/by octocat/)
    // jsdom does not resolve Mantine's CSS variables, so compare the size
    // token each Text emits (--text-fz: var(--mantine-font-size-<token>)).
    const SIZES = ["xs", "sm", "md", "lg", "xl"]
    const rank = (el: HTMLElement) => {
      const fz = el.style.getPropertyValue("--text-fz")
      const token = fz.match(/font-size-(\w+)/)?.[1] ?? ""
      return SIZES.indexOf(token)
    }
    expect(rank(note)).toBeGreaterThan(-1)
    expect(rank(note)).toBeGreaterThan(rank(meta))
  })
})

describe("resource title prominence", () => {
  const SIZES = ["xs", "sm", "md", "lg", "xl"]
  const rank = (el: HTMLElement) => {
    const fz = el.style.getPropertyValue("--text-fz")
    return SIZES.indexOf(fz.match(/font-size-(\w+)/)?.[1] ?? "")
  }

  it("renders the detail card's title larger and bolder than a list card's", () => {
    const r = { type: "pr", id: "o/r#1", url: "u", primary: true, title: "Fix the widget", state: "OPEN" } as ResourceDTO

    const detail = wrap(<ResourceCard r={r} path="/wt" variant="detail" />)
    const detailTitle = screen.getByText("Fix the widget")
    const detailRank = rank(detailTitle)
    const detailWeight = Number(detailTitle.style.fontWeight)
    detail.unmount()

    wrap(<ResourceCard r={r} path="/wt" onSelect={() => {}} />)
    const listTitle = screen.getByText("Fix the widget")

    expect(detailRank).toBeGreaterThan(rank(listTitle))
    expect(detailWeight).toBeGreaterThan(Number(listTitle.style.fontWeight))
  })

  it("gives a Slack thread's custom name the same prominence as a fetched title", () => {
    // The custom name IS the title for a thread that has none of its own, so
    // it must not render as a lesser thing.
    const named = { type: "slack", id: "C1:1.2", url: "u", primary: true, custom_name: "Deploy coordination" } as ResourceDTO
    const titled = { type: "slack", id: "C1:1.3", url: "u", primary: true, title: "Deploy coordination" } as ResourceDTO

    const a = wrap(<ResourceCard r={named} path="/wt" variant="detail" />)
    const customRank = rank(screen.getByText("Deploy coordination"))
    a.unmount()

    wrap(<ResourceCard r={titled} path="/wt" variant="detail" />)
    expect(customRank).toBe(rank(screen.getByText("Deploy coordination")))
  })
})

describe("PR card labelling", () => {
  it("names the service on the badge and keeps PR on the number", () => {
    // The badge matches Jira's and Slack's, which name the service; the
    // number would otherwise read as a bare "#1234".
    const r = { type: "pr", id: "o/r#1234", url: "u", primary: true, title: "Fix the widget", state: "OPEN" } as ResourceDTO
    wrap(<ResourceCard r={r} path="/wt" variant="detail" />)
    expect(screen.getByText("GitHub")).toBeInTheDocument()
    expect(screen.getByText("PR #1234")).toBeInTheDocument()
    expect(screen.queryByText("PR", { exact: true })).not.toBeInTheDocument()
  })
})

