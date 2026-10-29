import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AllResourceDTO } from "../api/types"
import { api } from "../api/client"
import { AllResourceSummary } from "./AllResourceRow"
import { WorktreeHoverCard } from "./tasks/LinkHoverCards"

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MantineProvider>{ui}</MantineProvider>
    </QueryClientProvider>,
  )

const matches = {
  available: true,
  matches: { "/wt/a": [{ ref: "workspace:3", title: "api", color: "#f00", selected: false }] },
}

beforeEach(() => {
  vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] } as never)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("CmuxSwitchButton", () => {
  it("switches cmux to the workspace", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue(matches)
    const select = vi.spyOn(api, "cmuxSelect").mockResolvedValue({ ok: true })
    wrap(<WorktreeHoverCard path="/wt/a"><span>target</span></WorktreeHoverCard>)
    await userEvent.hover(screen.getByText("target"))
    await userEvent.click(await screen.findByRole("button", { name: "Switch cmux to api" }))
    expect(select).toHaveBeenCalledWith("workspace:3")
  })

  it("does not trigger the card's target", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue(matches)
    vi.spyOn(api, "cmuxSelect").mockResolvedValue({ ok: true })
    const onClick = vi.fn()
    wrap(
      <div onClick={onClick}>
        <WorktreeHoverCard path="/wt/a"><span>target</span></WorktreeHoverCard>
      </div>,
    )
    await userEvent.hover(screen.getByText("target"))
    await userEvent.click(await screen.findByRole("button", { name: "Switch cmux to api" }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it("hides the switch button without cmux", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    wrap(<WorktreeHoverCard path="/wt/a"><span>target</span></WorktreeHoverCard>)
    await userEvent.hover(screen.getByText("target"))
    await screen.findByText(/⎇/)
    expect(screen.queryByRole("button", { name: /Switch cmux/ })).toBeNull()
  })

  it("shows the button in a resource hover card's worktree line", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue(matches)
    const r: AllResourceDTO = {
      type: "pr", id: "o/r#1", url: "https://github.com/o/r/pull/1", primary: true, title: "A PR",
      worktrees: [{ path: "/wt/a", repo: "r", branch: "b" }],
    }
    wrap(<AllResourceSummary r={r} preview={false} />)
    expect(await screen.findAllByRole("button", { name: "Switch cmux to api" })).toHaveLength(1)
  })
})
