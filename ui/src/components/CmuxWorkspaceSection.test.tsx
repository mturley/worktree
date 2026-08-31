import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { CmuxWorkspaceSection } from "./CmuxWorkspaceSection"
import { api } from "../api/client"

function renderSection(path = "/wt/a") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <CmuxWorkspaceSection path={path} branch="my-branch" />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

describe("CmuxWorkspaceSection", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("renders nothing when cmux is unavailable", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    const { container } = renderSection()
    // Nothing ever appears — not a spinner, not an error.
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector("[data-cmux-section]")).toBeNull()
  })

  it("renders one row per matching workspace", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: {
        "/wt/a": [
          { ref: "workspace:1", title: "main", color: "#AD1457", selected: false },
          { ref: "workspace:2", title: "review", selected: false },
        ],
      },
    })
    renderSection()
    expect(await screen.findByText("main")).toBeInTheDocument()
    expect(await screen.findByText("review")).toBeInTheDocument()
    expect(await screen.findAllByRole("button", { name: /switch/i })).toHaveLength(2)
  })

  it("shows Current, not Switch, for the selected workspace", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/a": [{ ref: "workspace:1", title: "main", selected: true }] },
    })
    renderSection()
    expect(await screen.findByRole("button", { name: /current/i })).toBeDisabled()
  })

  it("offers Create when cmux is up but nothing matches", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    renderSection()
    expect(await screen.findByText(/no cmux workspace/i)).toBeInTheDocument()
  })

  it("switches without navigating the card", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/a": [{ ref: "workspace:1", title: "main", selected: false }] },
    })
    const select = vi.spyOn(api, "cmuxSelect").mockResolvedValue({ ok: true })
    const onCardClick = vi.fn()

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MantineProvider>
        <QueryClientProvider client={qc}>
          <div onClick={onCardClick}>
            <CmuxWorkspaceSection path="/wt/a" branch="b" />
          </div>
        </QueryClientProvider>
      </MantineProvider>,
    )

    await userEvent.click(await screen.findByRole("button", { name: /switch/i }))
    expect(select).toHaveBeenCalledWith("workspace:1")
    // The home card is one big navigation target; the button must not bubble.
    expect(onCardClick).not.toHaveBeenCalled()
  })
})

describe("CmuxWorkspaceSection presentation", () => {
  const oneMatch = {
    available: true,
    matches: {
      "/wt/a": [{
        ref: "workspace:1",
        title: "wt-ui-fixes (resume after reset at 3:20)",
        color: "#AD1457",
        selected: false,
      }],
    },
  }

  it("renders the workspace name as the card's headline, not fine print", async () => {
    // Inside cmux the workspace is how you think about the work, so its name
    // is the heading and the worktree title steps down (see WorktreeCard).
    vi.spyOn(api, "cmux").mockResolvedValue(oneMatch)
    renderSection()
    const title = await screen.findByText(/resume after reset/)
    expect(title.className).toMatch(/mantine-Text-root/)
    // Header weight, not the dimmed xs the no-match row uses.
    expect(getComputedStyle(title).fontWeight).toBe("700")
  })

  it("wraps a long workspace name instead of truncating it", async () => {
    // A workspace title usually carries the status a person needs to read —
    // "(waiting for review)", "(blocked)" — and an ellipsis eats exactly that.
    vi.spyOn(api, "cmux").mockResolvedValue(oneMatch)
    renderSection()
    const title = await screen.findByText(/resume after reset/)
    expect(title.style.overflowWrap).toBe("anywhere")
    // Mantine renders lineClamp via -webkit-line-clamp; it must not be set.
    expect(title.style.getPropertyValue("-webkit-line-clamp")).toBe("")
  })

  it("gives the switch button a floor width so it cannot be squeezed", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue(oneMatch)
    renderSection()
    const btn = await screen.findByRole("button", { name: /switch/i })
    // flex:none plus a min width: the name is the flexible half of the row.
    // The DOM normalises `flex: none` to its longhand, so match that.
    expect(btn.style.flex).toBe("0 0 auto")
    // Mantine emits `min-width: calc(6rem * var(--mantine-scale))`, which
    // jsdom cannot compute — so assert the declaration carries a NON-ZERO
    // floor rather than reading a resolved pixel value. A dropped `miw`
    // leaves this empty; a `miw={0}` leaves no non-zero digit.
    expect(btn.style.minWidth).not.toBe("")
    expect(btn.style.minWidth).toMatch(/[1-9]/)
  })

  it("leaves breathing room under the workspace header", async () => {
    // The list card places the section as a bare sibling with no Stack gap
    // to inherit, so the spacing has to come from the section itself.
    vi.spyOn(api, "cmux").mockResolvedValue(oneMatch)
    const { container } = renderSection()
    await screen.findByText(/resume after reset/)
    const section = container.querySelector("[data-cmux-section]") as HTMLElement
    expect(section.style.marginBottom).not.toBe("")
    expect(section.style.marginBottom).toMatch(/[1-9]/)
  })

  it("marks the switch button with a terminal prompt icon", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue(oneMatch)
    renderSection()
    const btn = await screen.findByRole("button", { name: /switch/i })
    expect(btn.querySelector("svg")).not.toBeNull()
  })
})
