import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const apiMock = vi.hoisted(() => ({
  worktreeNotes: vi.fn(),
  saveWorktreeNotes: vi.fn(),
}))
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    ...actual,
    api: { ...actual.api, worktreeNotes: apiMock.worktreeNotes, saveWorktreeNotes: apiMock.saveWorktreeNotes },
  }
})

import { useWorktreeNotes } from "./useWorktreeNotes"

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

const loaded = (notes: string) => ({
  notes, sync_cmux: false, show_on_home: true, updated_at: "2026-01-01T00:00:00Z",
})
const saveResponse = (notes: string, at = "2026-01-01T00:00:05Z") => ({
  ...loaded(notes), updated_at: at, cmux_sync: "off" as const,
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function mount(text: string) {
  apiMock.worktreeNotes.mockResolvedValue(loaded(text))
  const hook = renderHook(() => useWorktreeNotes("/wt"), { wrapper: wrapper() })
  await waitFor(() => expect(hook.result.current.loaded).toBe(true))
  return hook
}

describe("useWorktreeNotes base text", () => {
  it("sends the loaded text as base_notes on the first save", async () => {
    apiMock.saveWorktreeNotes.mockResolvedValue(saveResponse("mine"))
    const { result } = await mount("loaded")
    act(() => result.current.setNotes("mine"))
    await act(async () => { await result.current.flush() })
    await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalled())
    expect(apiMock.saveWorktreeNotes.mock.calls[0][0]).toMatchObject({ notes: "mine", base_notes: "loaded" })
  })

  it("adopts merged server text when nothing was typed meanwhile", async () => {
    apiMock.saveWorktreeNotes.mockResolvedValue(saveResponse("mine + cmux"))
    const { result } = await mount("loaded")
    act(() => result.current.setNotes("mine"))
    await act(async () => { await result.current.flush() })
    await waitFor(() => expect(result.current.notes).toBe("mine + cmux"))
    expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(1)
  })

  it("keeps newer keystrokes and follows up with the first save's text as base", async () => {
    let resolveFirst: (v: ReturnType<typeof saveResponse>) => void = () => {}
    apiMock.saveWorktreeNotes
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
      .mockResolvedValueOnce(saveResponse("mine more", "2026-01-01T00:00:09Z"))
    const { result } = await mount("loaded")
    act(() => result.current.setNotes("mine"))
    act(() => { void result.current.flush() })
    await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(1))
    act(() => result.current.setNotes("mine more"))
    await act(async () => { resolveFirst(saveResponse("mine + cmux")) })
    await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2))
    expect(apiMock.saveWorktreeNotes.mock.calls[1][0]).toMatchObject({ notes: "mine more", base_notes: "mine" })
    expect(result.current.notes).toBe("mine more")
  })
})
