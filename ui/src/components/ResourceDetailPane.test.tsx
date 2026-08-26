import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { ResourceDTO } from "../api/types"

const useWorktreeTimeline = vi.fn()
vi.mock("../hooks/useTimeline", () => ({
  useWorktreeTimeline: (...args: unknown[]) => useWorktreeTimeline(...args),
}))

const removeResource = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api, removeResource: (...args: unknown[]) => removeResource(...args) } }
})

import { ResourceDetailPane } from "./ResourceDetailPane"

const jira: ResourceDTO = {
  type: "jira", id: "J-1", url: "https://jira/browse/J-1", primary: true,
  title: "Investigate flux", status: "In Progress", labels: ["backend"],
} as ResourceDTO

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

afterEach(() => {
  cleanup()
  useWorktreeTimeline.mockReset()
  removeResource.mockReset()
})

describe("ResourceDetailPane", () => {
  it("requests the timeline filtered to the selected resource", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(useWorktreeTimeline).toHaveBeenCalledWith("/wt/foo", { type: "jira", id: "J-1" })
  })

  it("shows the detailed resource summary, including Jira labels", () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(screen.getByText("backend")).toBeInTheDocument()
  })

  it("renders a back control only when onBack is supplied", async () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    const onBack = vi.fn()
    const user = userEvent.setup()
    const { rerender } = wrap(<ResourceDetailPane path="/wt/foo" resource={jira} onBack={onBack} />)
    await user.click(screen.getByRole("button", { name: /all resources/i }))
    expect(onBack).toHaveBeenCalled()

    rerender(<MantineProvider><ResourceDetailPane path="/wt/foo" resource={jira} /></MantineProvider>)
    expect(screen.queryByRole("button", { name: /all resources/i })).not.toBeInTheDocument()
  })

  it("wires the remove control to the real worktree path, not an empty one", async () => {
    useWorktreeTimeline.mockReturnValue({ events: [], isLoading: false, error: null, hasMore: false, loadMore: () => {}, loadingMore: false })
    removeResource.mockResolvedValue(undefined)
    const onRemoved = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} onRemoved={onRemoved} />)

    await user.click(screen.getByRole("button", { name: "Remove resource" }))
    await screen.findByText("Remove this resource?")
    await user.click(screen.getByRole("button", { name: "Remove" }))

    expect(removeResource).toHaveBeenCalledWith({ path: "/wt/foo", type: "jira", id: "J-1" })
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalled())
  })
})
