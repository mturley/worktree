import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { api } from "./client"
import { CMUX_SETTLE_MS, cmuxTreeKey, useCmuxMove } from "./cmuxTree"
import type { CmuxTreeResponse, CmuxTreeWorkspace } from "./types"

const PATH = "/wt/a"

function workspace(over: Partial<CmuxTreeWorkspace> = {}): CmuxTreeWorkspace {
  return {
    id: "W", ref: "workspace:1", title: "Alpha", selected: false,
    layout: { pane: "pane:1" },
    panes: [{ ref: "pane:1", focused: true, tabs: [
      { ref: "surface:1", title: "Tab 1", type: "browser", selected: true },
      { ref: "surface:2", title: "Tab 2", type: "browser", selected: false },
    ] }],
    ...over,
  }
}

function treeResponse(ws: CmuxTreeWorkspace): CmuxTreeResponse {
  return { available: true, workspaces: [ws] }
}

const MOVE = { surface: "surface:2", type: "browser", title: "Tab 2", pane: "pane:1" }
const CLOSE = { surface: "surface:2", type: "browser", title: "Tab 2" }

/**
 * `invalidateQueries` is how `useCmuxMove` asks for the tree to be re-read
 * (the actual refetch then depends on an active `useCmuxTree` observer, which
 * these tests don't need — the hook's own refetch-timing contract is what
 * calling `invalidateQueries` at the right moment proves).
 */
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(cmuxTreeKey(PATH), treeResponse(workspace()))
  const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return { qc, invalidate, wrapper }
}

describe("useCmuxMove", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("writes the optimistic move to the cache before the request resolves", async () => {
    const { qc, wrapper } = setup()
    let resolveMove: (r: { ok: boolean }) => void = () => {}
    vi.spyOn(api, "cmuxMoveTab").mockReturnValue(new Promise((resolve) => { resolveMove = resolve }))
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    let settled = false
    let p!: Promise<void>
    act(() => { p = result.current.move(workspace(), MOVE).then(() => { settled = true }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    const cached = qc.getQueryData<CmuxTreeResponse>(cmuxTreeKey(PATH))
    expect(cached?.workspaces[0].panes?.[0].tabs.map((t) => t.ref)).toEqual(["surface:1", "surface:2"])
    // A same-pane reorder doesn't change selection; surface:1 was already selected.
    expect(cached?.workspaces[0].panes?.[0].tabs.find((t) => t.selected)?.ref).toBe("surface:1")
    expect(settled).toBe(false)

    resolveMove({ ok: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(CMUX_SETTLE_MS) })
    await p
  })

  it("on success: no refetch before CMUX_SETTLE_MS, one after, and resolves null", async () => {
    const { invalidate, wrapper } = setup()
    const moveTab = vi.spyOn(api, "cmuxMoveTab").mockResolvedValue({ ok: true })
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    let p!: ReturnType<typeof result.current.move>
    act(() => { p = result.current.move(workspace(), MOVE) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(moveTab).toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(CMUX_SETTLE_MS - 1) })
    expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: cmuxTreeKey(PATH) }))

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: cmuxTreeKey(PATH) }))

    expect(await p).toBeNull()
  })

  it("on a stale rejection: refetches immediately, no settle wait, resolves the message", async () => {
    const { invalidate, wrapper } = setup()
    vi.spyOn(api, "cmuxMoveTab").mockResolvedValue({ ok: false, stale: true, error: "stale tab" })
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    let message: string | null = null
    await act(async () => { message = await result.current.move(workspace(), MOVE) })
    expect(message).toBe("stale tab")
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: cmuxTreeKey(PATH) }))
  })

  it("on a thrown error: refetches immediately, resolves the error message", async () => {
    const { invalidate, wrapper } = setup()
    vi.spyOn(api, "cmuxMoveTab").mockRejectedValue(new Error("network down"))
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    let message: string | null = null
    await act(async () => { message = await result.current.move(workspace(), MOVE) })
    expect(message).toBe("network down")
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: cmuxTreeKey(PATH) }))
  })

  it("moving is true while a move is in flight and false after", async () => {
    const { wrapper } = setup()
    let resolveMove: (r: { ok: boolean }) => void = () => {}
    vi.spyOn(api, "cmuxMoveTab").mockReturnValue(new Promise((resolve) => { resolveMove = resolve }))
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    expect(result.current.moving).toBe(false)
    let p!: ReturnType<typeof result.current.move>
    act(() => { p = result.current.move(workspace(), MOVE) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.moving).toBe(true)

    resolveMove({ ok: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(CMUX_SETTLE_MS) })
    await p
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.moving).toBe(false)
  })

  it("an overlapping second move is not snapped back by the first move's delayed refetch", async () => {
    const { invalidate, wrapper } = setup()
    let resolveFirst: (r: { ok: boolean }) => void = () => {}
    let resolveSecond: (r: { ok: boolean }) => void = () => {}
    const moveTab = vi.spyOn(api, "cmuxMoveTab")
    moveTab.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    moveTab.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    let p1!: ReturnType<typeof result.current.move>
    act(() => { p1 = result.current.move(workspace(), MOVE) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(moveTab).toHaveBeenCalledTimes(1)

    let p2!: ReturnType<typeof result.current.move>
    act(() => { p2 = result.current.move(workspace(), { ...MOVE, surface: "surface:1" }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(moveTab).toHaveBeenCalledTimes(2)

    // The first move's request resolves and it waits out its settle delay;
    // the second is still in flight (its own request has not resolved), so
    // the first's completion must not invalidate yet.
    resolveFirst({ ok: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(CMUX_SETTLE_MS) })
    await p1
    expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: cmuxTreeKey(PATH) }))

    // The second (also successful) move's request resolves and it waits out
    // its own settle delay: now the one invalidate happens, for the last
    // move still outstanding.
    resolveSecond({ ok: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(CMUX_SETTLE_MS) })
    await p2
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: cmuxTreeKey(PATH) }))
  })
})

describe("useCmuxMove close", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("writes the optimistic close to the cache before the request resolves", async () => {
    const { qc, wrapper } = setup()
    let resolveClose: (r: { ok: boolean }) => void = () => {}
    vi.spyOn(api, "cmuxCloseTab").mockReturnValue(new Promise((resolve) => { resolveClose = resolve }))
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    let settled = false
    let p!: Promise<void>
    act(() => { p = result.current.close(workspace(), CLOSE).then(() => { settled = true }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    const cached = qc.getQueryData<CmuxTreeResponse>(cmuxTreeKey(PATH))
    expect(cached?.workspaces[0].panes?.[0].tabs.map((t) => t.ref)).toEqual(["surface:1"])
    expect(settled).toBe(false)

    resolveClose({ ok: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(CMUX_SETTLE_MS) })
    await p
  })

  it("on success: no refetch before CMUX_SETTLE_MS, one after, and resolves null", async () => {
    const { invalidate, wrapper } = setup()
    const closeTab = vi.spyOn(api, "cmuxCloseTab").mockResolvedValue({ ok: true })
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    let p!: ReturnType<typeof result.current.close>
    act(() => { p = result.current.close(workspace(), CLOSE) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(closeTab).toHaveBeenCalledWith("W", CLOSE)

    await act(async () => { await vi.advanceTimersByTimeAsync(CMUX_SETTLE_MS - 1) })
    expect(invalidate).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: cmuxTreeKey(PATH) }))

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: cmuxTreeKey(PATH) }))

    expect(await p).toBeNull()
  })

  it("on a stale rejection: refetches immediately, no settle wait, resolves the message", async () => {
    const { invalidate, wrapper } = setup()
    vi.spyOn(api, "cmuxCloseTab").mockResolvedValue({ ok: false, stale: true, error: "stale tab" })
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    let message: string | null = null
    await act(async () => { message = await result.current.close(workspace(), CLOSE) })
    expect(message).toBe("stale tab")
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: cmuxTreeKey(PATH) }))
  })

  it("on a thrown error: refetches immediately, resolves the error message", async () => {
    const { invalidate, wrapper } = setup()
    vi.spyOn(api, "cmuxCloseTab").mockRejectedValue(new Error("network down"))
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    let message: string | null = null
    await act(async () => { message = await result.current.close(workspace(), CLOSE) })
    expect(message).toBe("network down")
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: cmuxTreeKey(PATH) }))
  })

  it("moving is true while a close is in flight and false after (shared with move)", async () => {
    const { wrapper } = setup()
    let resolveClose: (r: { ok: boolean }) => void = () => {}
    vi.spyOn(api, "cmuxCloseTab").mockReturnValue(new Promise((resolve) => { resolveClose = resolve }))
    const { result } = renderHook(() => useCmuxMove(PATH), { wrapper })

    expect(result.current.moving).toBe(false)
    let p!: ReturnType<typeof result.current.close>
    act(() => { p = result.current.close(workspace(), CLOSE) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.moving).toBe(true)

    resolveClose({ ok: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(CMUX_SETTLE_MS) })
    await p
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.moving).toBe(false)
  })
})
