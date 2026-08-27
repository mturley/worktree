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
