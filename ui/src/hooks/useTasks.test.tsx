import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useTaskMutations, useTasks, taskScopeKey, type TaskScope } from "./useTasks"
import { api } from "../api/client"
import type { Task } from "../api/types"

vi.mock("../api/client", async (orig) => ({
  ...(await orig<typeof import("../api/client")>()),
  api: {
    tasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    setTaskState: vi.fn(),
    moveTask: vi.fn(),
  },
}))

const task = (id: number, extra: Partial<Task> = {}): Task => ({
  id, ref: `T${id}`, title: `t${id}`, description: "", state: "not_started", priority: "none", starred: false,
  rank: `r${id}`, created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
  subtasks_total: 0, subtasks_done: 0, ...extra,
})
const [A, B, C] = [task(1), task(2), task(3)]
const ids = (ts?: Task[]) => ts?.map((t) => t.id)

function setup(scope: TaskScope) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(qc, "invalidateQueries")
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    () => ({ q: useTasks(scope, { completed: false, archived: false }), m: useTaskMutations(scope) }),
    { wrapper },
  )
  return { ...hook, invalidate }
}

beforeEach(() => {
  vi.mocked(api.tasks).mockResolvedValue([A, B, C])
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("taskScopeKey", () => {
  it("is rooted at tasks for every scope", () => {
    expect(taskScopeKey({ kind: "all" })[0]).toBe("tasks")
    expect(taskScopeKey({ kind: "worktree", path: "/w" })[0]).toBe("tasks")
    expect(taskScopeKey({ kind: "resource", type: "pr", id: "1" })[0]).toBe("tasks")
  })
})

describe("useTasks", () => {
  it("queries the scope and flags", async () => {
    const { result } = setup({ kind: "worktree", path: "/w" })
    await waitFor(() => expect(result.current.q.data).toBeDefined())
    expect(api.tasks).toHaveBeenCalledWith({ kind: "worktree", path: "/w" }, { completed: false, archived: false })
  })
})

describe("useTaskMutations", () => {
  it("move reorders the cached list optimistically and rolls back on failure", async () => {
    const { result } = setup({ kind: "all" })
    await waitFor(() => expect(ids(result.current.q.data)).toEqual([1, 2, 3]))
    let reject!: (e: Error) => void
    vi.mocked(api.moveTask).mockReturnValue(new Promise<void>((_, rj) => { reject = rj }))

    let p!: Promise<void>
    act(() => { p = result.current.m.move(3, { after: 1 }) })
    await waitFor(() => expect(ids(result.current.q.data)).toEqual([1, 3, 2]))
    reject(new Error("boom"))
    await act(async () => { await expect(p).rejects.toThrow("boom") })
    await waitFor(() => expect(ids(result.current.q.data)).toEqual([1, 2, 3]))
  })

  it("move with a patch updates first, then moves", async () => {
    const { result } = setup({ kind: "all" })
    await waitFor(() => expect(result.current.q.data).toBeDefined())
    const order: string[] = []
    vi.mocked(api.updateTask).mockImplementation(async () => { order.push("update"); return task(3) })
    vi.mocked(api.moveTask).mockImplementation(async () => { order.push("move") })
    await act(async () => { await result.current.m.move(3, { before: 1 }, { starred: true }) })
    expect(order).toEqual(["update", "move"])
    expect(api.updateTask).toHaveBeenCalledWith(3, { starred: true })
    expect(api.moveTask).toHaveBeenCalledWith(3, { before: 1 })
  })

  it("create sends the worktree scope's context", async () => {
    vi.mocked(api.createTask).mockResolvedValue(task(9))
    const { result } = setup({ kind: "worktree", path: "/X" })
    await act(async () => { await result.current.m.create({ title: "n", priority: "none", starred: false }) })
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "n", path: "/X" }))
  })

  it("create sends the resource scope's context", async () => {
    vi.mocked(api.createTask).mockResolvedValue(task(9))
    const { result } = setup({ kind: "resource", type: "pr", id: "1" })
    await act(async () => { await result.current.m.create({ title: "n", priority: "high", starred: true, after: 2 }) })
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ type: "pr", id: "1", after: 2, starred: true }))
    expect(vi.mocked(api.createTask).mock.calls[0][0]).not.toHaveProperty("path")
  })

  it("invalidates tasks, worktrees and resources when a mutation settles", async () => {
    vi.mocked(api.setTaskState).mockResolvedValue(task(1))
    const { result, invalidate } = setup({ kind: "all" })
    await act(async () => { await result.current.m.setState(1, "done") })
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
    expect(keys).toEqual(expect.arrayContaining([JSON.stringify(["tasks"]), JSON.stringify(["worktrees"]), JSON.stringify(["resources"])]))
  })
})
