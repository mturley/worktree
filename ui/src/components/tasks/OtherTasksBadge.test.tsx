import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { Task, TaskLink } from "../../api/types"
import { OtherTasksBadge } from "./OtherTasksBadge"

vi.mock("../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../api/client")>()),
  api: { tasks: vi.fn() },
}))

const task = (id: number, extra: Partial<Task> = {}): Task => ({
  id, ref: `T${id}`, title: `task ${id}`, description: "", state: "not_started", priority: "none", starred: false,
  rank: `r${id}`, created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
  subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, open_blockers: [], ...extra,
})
const prLink: TaskLink = { kind: "resource", resource_type: "pr", resource_id: "o/r#1", focus: true, archived: false }

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <OtherTasksBadge path="/w" resource={{ type: "pr", id: "o/r#1" }} />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("OtherTasksBadge", () => {
  it("counts the worktree's open tasks that do not link the selected resource", async () => {
    vi.mocked(api.tasks).mockResolvedValue([
      task(1, { links: [prLink] }),
      task(2),
      task(3, { state: "in_progress" }),
      task(4, { state: "done" }),
    ])
    wrap()
    expect(await screen.findByText("2 other tasks")).toBeInTheDocument()
    expect(vi.mocked(api.tasks).mock.calls[0][0]).toMatchObject({ kind: "worktree", path: "/w" })
  })

  it("drops \"other\" when the resource has no open tasks of its own", async () => {
    vi.mocked(api.tasks).mockResolvedValue([
      task(1, { links: [prLink], state: "done" }),
      task(2),
      task(3),
    ])
    wrap()
    expect(await screen.findByText("2 tasks")).toBeInTheDocument()
    expect(screen.queryByText(/other/)).toBeNull()
  })

  it("renders nothing when every open task links the resource", async () => {
    vi.mocked(api.tasks).mockResolvedValue([task(1, { links: [prLink] })])
    const { container } = wrap()
    await vi.waitFor(() => expect(api.tasks).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector(".task-count-badge")).toBeNull()
  })
})
