import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useTaskMutations, useTasks, taskScopeKey, type TaskScope } from "./useTasks"
import { api } from "../api/client"
import type { Task } from "../api/types"
import { buildSections } from "../lib/taskSections"

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
  subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [], ...extra,
})
const [A, B, C] = [task(1), task(2), task(3)]
const ids = (ts?: Task[]) => ts?.map((t) => t.id)
/** Ids in display order: the list sorts by rank, not by array position. */
const shown = (ts?: Task[]) =>
  buildSections(ts ?? [], { sort: "custom", showCompleted: false, includeArchived: false }, []).flatMap((s) => s.tasks.map((t) => t.id))

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
  /** The scope's cached list, read straight from the cache, not via a render. */
  const cached = () => qc.getQueriesData<Task[]>({ queryKey: taskScopeKey(scope) })[0]?.[1]
  return { ...hook, invalidate, cached }
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

describe("useTasks while its flags change", () => {
  it("keeps the previous list while the new one loads, so the list never drops to Loading", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result, rerender } = renderHook(
      ({ completed }: { completed: boolean }) => useTasks({ kind: "all" }, { completed, archived: false }),
      { wrapper, initialProps: { completed: false } },
    )
    await waitFor(() => expect(ids(result.current.data)).toEqual([1, 2, 3]))

    let resolve!: (ts: Task[]) => void
    vi.mocked(api.tasks).mockReturnValue(new Promise<Task[]>((r) => { resolve = r }))
    rerender({ completed: true })
    expect(result.current.isPending).toBe(false)
    expect(result.current.isPlaceholderData).toBe(true)
    expect(ids(result.current.data)).toEqual([1, 2, 3])

    act(() => resolve([A, B, C, task(4, { state: "done" })]))
    await waitFor(() => expect(ids(result.current.data)).toEqual([1, 2, 3, 4]))
    expect(result.current.isPlaceholderData).toBe(false)
  })

  it("does not carry one scope's tasks over to another", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result, rerender } = renderHook(
      ({ scope }: { scope: TaskScope }) => useTasks(scope, { completed: false, archived: false }),
      { wrapper, initialProps: { scope: { kind: "worktree", path: "/a" } as TaskScope } },
    )
    await waitFor(() => expect(ids(result.current.data)).toEqual([1, 2, 3]))

    vi.mocked(api.tasks).mockReturnValue(new Promise<Task[]>(() => {}))
    rerender({ scope: { kind: "worktree", path: "/b" } })
    expect(result.current.isPending).toBe(true)
    expect(result.current.data).toBeUndefined()
  })
})

describe("useTaskMutations", () => {
  it("move reorders the cached list optimistically and rolls back on failure", async () => {
    const { result, cached } = setup({ kind: "all" })
    await waitFor(() => expect(ids(result.current.q.data)).toEqual([1, 2, 3]))
    let reject!: (e: Error) => void
    vi.mocked(api.moveTask).mockReturnValue(new Promise<void>((_, rj) => { reject = rj }))

    let p!: Promise<void>
    act(() => { p = result.current.m.move(3, { after: 1 }) })
    // At once, before anything awaits, and in the order the list SHOWS: by rank.
    expect(shown(cached())).toEqual([1, 3, 2])
    await waitFor(() => expect(shown(result.current.q.data)).toEqual([1, 3, 2]))
    reject(new Error("boom"))
    await act(async () => { await expect(p).rejects.toThrow("boom") })
    await waitFor(() => expect(shown(result.current.q.data)).toEqual([1, 2, 3]))
  })

  it("move cancels an in-flight fetch without it reverting the optimistic write", async () => {
    const { result } = setup({ kind: "all" })
    await waitFor(() => expect(ids(result.current.q.data)).toEqual([1, 2, 3]))
    // A refetch in flight (an SSE invalidation) that would answer the old order.
    vi.mocked(api.tasks).mockReturnValue(new Promise(() => {}))
    act(() => { void result.current.q.refetch() })
    vi.mocked(api.moveTask).mockReturnValue(new Promise(() => {}))
    act(() => { void result.current.m.move(3, { after: 1 }) })
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(shown(result.current.q.data)).toEqual([1, 3, 2])
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
