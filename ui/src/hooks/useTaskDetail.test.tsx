import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useTaskActivity, useTaskDetail, useTaskDetailMutations } from "./useTaskDetail"
import type { TaskDetail, TaskEventSnapshot, TaskLinkTarget, TimelineEvent } from "../api/types"

const detail = (extra: Partial<TaskDetail> = {}): TaskDetail => ({
  id: 7, ref: "T7", title: "t", description: "", state: "not_started", priority: "none", starred: false,
  rank: "r", created_at: "", updated_at: "", archived: false, links: [], implicit_worktrees: [],
  subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, open_blockers: [], detail_links: [], implicit: [], subtasks: [], event_links: [], blockers: [], blocks: [], ...extra,
})

let fetchMock: ReturnType<typeof vi.fn>
function mockFetch(respond: (url: string, init?: RequestInit) => unknown) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = respond(url, init)
    return { ok: true, status: body === null ? 204 : 200, headers: new Headers(), json: async () => body }
  })
  vi.stubGlobal("fetch", fetchMock)
}
const calls = (path: string) => fetchMock.mock.calls.filter(([u]) => String(u).startsWith(path))
const bodyOf = (path: string) => JSON.parse(calls(path)[0][1].body as string)

function setup<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(qc, "invalidateQueries")
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return { qc, invalidate, ...renderHook(hook, { wrapper }) }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("useTaskDetail", () => {
  it("fetches the detail under the tasks root key", async () => {
    mockFetch(() => detail())
    const { result, qc } = setup(() => useTaskDetail(7))
    await waitFor(() => expect(result.current.data?.id).toBe(7))
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/tasks/detail?id=7")
    expect(qc.getQueryData(["tasks", "detail", 7])).toBeTruthy()
  })

  it("does not fetch without an id", () => {
    mockFetch(() => detail())
    setup(() => useTaskDetail(undefined))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("useTaskActivity", () => {
  it("keys on the filter and queries it", async () => {
    mockFetch(() => [])
    const { qc } = setup(() => useTaskActivity(7, { filter: "linked" }))
    await waitFor(() => expect(qc.getQueryData(["tasks", "activity", 7, "linked"])).toEqual([]))
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/tasks/activity?id=7&filter=linked")
  })

  it("adds type and rid to the key and query for the resource filter", async () => {
    const ev = { id: "e1" } as TimelineEvent
    mockFetch(() => [ev])
    const { result, qc } = setup(() => useTaskActivity(7, { filter: "resource", type: "pr", rid: "o/r#1" }))
    await waitFor(() => expect(result.current.data).toEqual([ev]))
    expect(qc.getQueryData(["tasks", "activity", 7, "resource", "pr", "o/r#1"])).toEqual([ev])
    const u = new URL(String(fetchMock.mock.calls[0][0]), "http://x")
    expect(u.searchParams.get("filter")).toBe("resource")
    expect(u.searchParams.get("type")).toBe("pr")
    expect(u.searchParams.get("rid")).toBe("o/r#1")
  })
})

describe("useTaskDetailMutations", () => {
  const res: TaskLinkTarget = { kind: "resource", type: "pr", rid: "o/r#1" }
  const wt: TaskLinkTarget = { kind: "worktree", path: "/w" }
  const snap: TaskEventSnapshot = {
    source: "slack", type: "message", title: "T", author: "a", body: "b", url: "u", ts: "ts",
    resource_type: "slack_thread", resource_id: "C:1",
  }

  const cases: [string, string, (m: ReturnType<typeof useTaskDetailMutations>) => Promise<unknown>, unknown][] = [
    ["update", "/api/tasks/update", (m) => m.update({ description: "d", due: "" }), { id: 7, description: "d", due: "" }],
    ["setState", "/api/tasks/state", (m) => m.setState("done"), { id: 7, state: "done" }],
    ["delete", "/api/tasks/delete", (m) => m.remove(), { id: 7 }],
    ["addLink url", "/api/tasks/links/add", (m) => m.addLink({ url: "https://x/y" }, true), { id: 7, url: "https://x/y", focus: true }],
    ["addLink resource", "/api/tasks/links/add", (m) => m.addLink(res), { id: 7, type: "pr", rid: "o/r#1" }],
    ["addLink worktree", "/api/tasks/links/add", (m) => m.addLink(wt, false), { id: 7, path: "/w", focus: false }],
    ["removeLink", "/api/tasks/links/remove", (m) => m.removeLink(res), { id: 7, kind: "resource", type: "pr", rid: "o/r#1" }],
    ["setLinkFocus", "/api/tasks/links/focus", (m) => m.setLinkFocus(wt, true), { id: 7, kind: "worktree", path: "/w", focus: true }],
    ["orderLinks", "/api/tasks/links/order", (m) => m.orderLinks([res], [wt]), { id: 7, focus: [res], related: [wt] }],
    ["addSubtask", "/api/tasks/subtasks/add", (m) => m.addSubtask("x"), { id: 7, text: "x" }],
    ["editSubtask", "/api/tasks/subtasks/edit", (m) => m.editSubtask(3, "y"), { subtask_id: 3, text: "y" }],
    ["checkSubtask", "/api/tasks/subtasks/check", (m) => m.checkSubtask(3, true), { subtask_id: 3, checked: true }],
    ["removeSubtask", "/api/tasks/subtasks/remove", (m) => m.removeSubtask(3), { subtask_id: 3 }],
    ["orderSubtasks", "/api/tasks/subtasks/order", (m) => m.orderSubtasks([2, 1]), { id: 7, ids: [2, 1] }],
    ["linkEvent", "/api/tasks/events/link", (m) => m.linkEvent("slack:C:1", snap), { id: 7, key: "slack:C:1", snapshot: snap }],
    ["unlinkEvent", "/api/tasks/events/unlink", (m) => m.unlinkEvent("ev:9"), { id: 7, key: "ev:9" }],
    ["addBlocker task", "/api/tasks/blockers/add", (m) => m.addBlocker({ kind: "task", task_id: 4 }), { id: 7, kind: "task", task_id: 4 }],
    ["addBlocker url", "/api/tasks/blockers/add", (m) => m.addBlocker({ kind: "resource", url: "https://x/y" }), { id: 7, kind: "resource", url: "https://x/y" }],
    ["addBlocker resource", "/api/tasks/blockers/add", (m) => m.addBlocker({ kind: "resource", type: "pr", rid: "o/r#1" }), { id: 7, kind: "resource", type: "pr", rid: "o/r#1" }],
    ["addBlocker other", "/api/tasks/blockers/add", (m) => m.addBlocker({ kind: "other", text: "legal" }), { id: 7, kind: "other", text: "legal" }],
    ["removeBlocker", "/api/tasks/blockers/remove", (m) => m.removeBlocker(5), { blocker_id: 5 }],
    ["resolveBlocker", "/api/tasks/blockers/resolve", (m) => m.resolveBlocker(5, true), { blocker_id: 5, resolved: true }],
    ["fromEvent", "/api/tasks/from-event", (m) => m.fromEvent("ev:9", undefined, "/w"), { key: "ev:9", path: "/w" }],
  ]

  it.each(cases)("%s posts the right body and invalidates", async (_n, path, run, want) => {
    mockFetch((url) => (url === "/api/tasks/delete" ? null : detail()))
    const { result, invalidate } = setup(() => useTaskDetailMutations(7))
    await act(async () => {
      await run(result.current)
    })
    expect(calls(path)).toHaveLength(1)
    expect(bodyOf(path)).toEqual(want)
    const keys = invalidate.mock.calls.map(([f]) => (f as { queryKey: unknown[] }).queryKey[0])
    expect(keys).toEqual(expect.arrayContaining(["tasks", "worktrees", "resources"]))
  })

  it("refetches the detail query after a mutation", async () => {
    let title = "before"
    mockFetch((url) => (url.startsWith("/api/tasks/detail") ? detail({ title }) : detail({ title: "after" })))
    const { result } = setup(() => ({ q: useTaskDetail(7), m: useTaskDetailMutations(7) }))
    await waitFor(() => expect(result.current.q.data?.title).toBe("before"))
    title = "after"
    await act(async () => {
      await result.current.m.setState("done")
    })
    await waitFor(() => expect(result.current.q.data?.title).toBe("after"))
    expect(calls("/api/tasks/detail").length).toBeGreaterThanOrEqual(2)
  })

  it("fromEvent returns the created detail", async () => {
    mockFetch(() => detail({ id: 99 }))
    const { result } = setup(() => useTaskDetailMutations(7))
    let d: TaskDetail | undefined
    await act(async () => {
      d = await result.current.fromEvent("ev:1")
    })
    expect(d?.id).toBe(99)
  })

  it("still invalidates when the request fails", async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 500, headers: new Headers(), json: async () => ({ error: "no" }) }))
    vi.stubGlobal("fetch", fetchMock)
    const { result, invalidate } = setup(() => useTaskDetailMutations(7))
    await act(async () => {
      await expect(result.current.addSubtask("x")).rejects.toThrow("no")
    })
    expect(invalidate).toHaveBeenCalled()
  })
})
