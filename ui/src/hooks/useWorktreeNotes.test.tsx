import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
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
  cleanup() // unmounting sends pending edits; let that happen before the mocks reset
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
    await waitFor(() => expect(result.current.status).toBe("saved"))
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

  describe("keepalive on leaving", () => {
    it("sends the loaded text as base when idle", async () => {
      apiMock.saveWorktreeNotes.mockResolvedValue(saveResponse("mine"))
      const { result } = await mount("loaded")
      act(() => result.current.setNotes("mine"))
      act(() => { window.dispatchEvent(new Event("beforeunload")) })
      expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(1)
      expect(apiMock.saveWorktreeNotes.mock.calls[0][0]).toMatchObject({ notes: "mine", base_notes: "loaded" })
      expect(apiMock.saveWorktreeNotes.mock.calls[0][1]).toEqual({ keepalive: true })
    })

    // The in-flight save is not keepalive: closing the tab aborts it. So the
    // keepalive always goes out, based on what the in-flight save was based
    // on, which is right whether or not that save reached the server.
    it("still sends while a save is in flight, with the pre-flight base", async () => {
      apiMock.saveWorktreeNotes.mockImplementationOnce(() => new Promise(() => {}))
      const { result } = await mount("loaded")
      act(() => result.current.setNotes("mine"))
      act(() => { void result.current.flush() })
      await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(1))
      act(() => { window.dispatchEvent(new Event("beforeunload")) })
      expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2)
      expect(apiMock.saveWorktreeNotes.mock.calls[1][0]).toMatchObject({ notes: "mine", base_notes: "loaded" })
      expect(apiMock.saveWorktreeNotes.mock.calls[1][1]).toEqual({ keepalive: true })
    })

    it("uses the pre-flight base when typed past the in-flight save", async () => {
      apiMock.saveWorktreeNotes.mockImplementationOnce(() => new Promise(() => {}))
      apiMock.saveWorktreeNotes.mockResolvedValue(saveResponse("mine more"))
      const { result } = await mount("loaded")
      act(() => result.current.setNotes("mine"))
      act(() => { void result.current.flush() })
      await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(1))
      act(() => result.current.setNotes("mine more"))
      act(() => { window.dispatchEvent(new Event("beforeunload")) })
      expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2)
      expect(apiMock.saveWorktreeNotes.mock.calls[1][0]).toMatchObject({ notes: "mine more", base_notes: "loaded" })
    })

    // The keepalive carries the edits now; a follow-up from the in-flight
    // save would resend them with that save's text as base, and against
    // whatever the keepalive stored that nests conflict markers.
    it("sends no follow-up save once beforeunload has handed the edits off", async () => {
      let resolveFirst: (v: ReturnType<typeof saveResponse>) => void = () => {}
      apiMock.saveWorktreeNotes
        .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r }))
        .mockResolvedValue(saveResponse("mine more"))
      const { result } = await mount("loaded")
      act(() => result.current.setNotes("mine"))
      act(() => { void result.current.flush() })
      await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(1))
      act(() => result.current.setNotes("mine more"))
      act(() => { window.dispatchEvent(new Event("beforeunload")) })
      expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2)
      await act(async () => { resolveFirst(saveResponse("mine")) })
      await act(async () => { await Promise.resolve() })
      expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2)
    })

    // Leaving within the app does not abort the in-flight save, so its own
    // follow-up sends the rest once it returns, based on what it stored: a
    // clean merge. A keepalive racing it with the pre-flight base would
    // conflict whichever request landed second.
    describe("unmounting while a save is in flight", () => {
      async function unmountMidSave() {
        let resolveFirst: (v: ReturnType<typeof saveResponse>) => void = () => {}
        let rejectFirst: (e: Error) => void = () => {}
        apiMock.saveWorktreeNotes
          .mockImplementationOnce(() => new Promise((res, rej) => { resolveFirst = res; rejectFirst = rej }))
          .mockResolvedValue(saveResponse("mine more", "2026-01-01T00:00:09Z"))
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        apiMock.worktreeNotes.mockResolvedValue(loaded("loaded"))
        const hook = renderHook(() => useWorktreeNotes("/wt"), {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
          ),
        })
        await waitFor(() => expect(hook.result.current.loaded).toBe(true))
        act(() => hook.result.current.setNotes("mine"))
        act(() => { void hook.result.current.flush() })
        await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(1))
        act(() => hook.result.current.setNotes("mine more"))
        hook.unmount()
        return { client, resolveFirst: (v: ReturnType<typeof saveResponse>) => resolveFirst(v), rejectFirst: (e: Error) => rejectFirst(e) }
      }

      it("sends no keepalive, but puts the edits in the cache for the next visit", async () => {
        const { client, resolveFirst } = await unmountMidSave()
        expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(1)
        expect(client.getQueryData<{ notes: string }>(["worktree-notes", "/wt"])?.notes).toBe("mine more")
        // Settle the save so its beforeunload listener does not outlive the test.
        await act(async () => { resolveFirst(saveResponse("mine")) })
        await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2))
      })

      it("follows up with the in-flight save's text as base when it returns", async () => {
        const { client, resolveFirst } = await unmountMidSave()
        await act(async () => { resolveFirst(saveResponse("mine")) })
        await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2))
        expect(apiMock.saveWorktreeNotes.mock.calls[1][0]).toMatchObject({ notes: "mine more", base_notes: "mine" })
        expect(client.getQueryData<{ notes: string }>(["worktree-notes", "/wt"])?.notes).toBe("mine more")
        await waitFor(() => expect(client.getQueryData<{ updated_at: string }>(["worktree-notes", "/wt"])?.updated_at)
          .toBe("2026-01-01T00:00:09Z"))
      })

      it("hands off to a keepalive if the tab closes before the save returns", async () => {
        const { resolveFirst } = await unmountMidSave()
        act(() => { window.dispatchEvent(new Event("beforeunload")) })
        expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2)
        expect(apiMock.saveWorktreeNotes.mock.calls[1][0]).toMatchObject({ notes: "mine more", base_notes: "loaded" })
        expect(apiMock.saveWorktreeNotes.mock.calls[1][1]).toEqual({ keepalive: true })
        await act(async () => { resolveFirst(saveResponse("mine")) })
        await act(async () => { await Promise.resolve() })
        expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2)
      })

      it("stops listening for beforeunload once the follow-up has landed", async () => {
        const { resolveFirst } = await unmountMidSave()
        await act(async () => { resolveFirst(saveResponse("mine")) })
        await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2))
        await act(async () => { await Promise.resolve() })
        act(() => { window.dispatchEvent(new Event("beforeunload")) })
        expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2)
      })

      it("sends the edits by keepalive if the in-flight save fails", async () => {
        const { rejectFirst } = await unmountMidSave()
        await act(async () => { rejectFirst(new Error("boom")) })
        await waitFor(() => expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(2))
        expect(apiMock.saveWorktreeNotes.mock.calls[1][0]).toMatchObject({ notes: "mine more", base_notes: "loaded" })
        expect(apiMock.saveWorktreeNotes.mock.calls[1][1]).toEqual({ keepalive: true })
      })
    })

    it("sends the keepalive on unmount when no save is in flight", async () => {
      apiMock.saveWorktreeNotes.mockResolvedValue(saveResponse("mine"))
      const { result, unmount } = await mount("loaded")
      act(() => result.current.setNotes("mine"))
      unmount()
      expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(1)
      expect(apiMock.saveWorktreeNotes.mock.calls[0][0]).toMatchObject({ notes: "mine", base_notes: "loaded" })
      expect(apiMock.saveWorktreeNotes.mock.calls[0][1]).toEqual({ keepalive: true })
    })

    // Browsers cap a keepalive body at 64 KiB; past that the fetch fails.
    it("omits base_notes when the body would be too large for keepalive", async () => {
      apiMock.saveWorktreeNotes.mockResolvedValue(saveResponse("x"))
      const big = "a".repeat(35_000)
      const { result } = await mount(big)
      act(() => result.current.setNotes(big + "b"))
      act(() => { window.dispatchEvent(new Event("beforeunload")) })
      expect(apiMock.saveWorktreeNotes).toHaveBeenCalledTimes(1)
      const sent = apiMock.saveWorktreeNotes.mock.calls[0][0]
      expect(sent.notes).toBe(big + "b")
      expect(sent).not.toHaveProperty("base_notes")
      expect(apiMock.saveWorktreeNotes.mock.calls[0][1]).toEqual({ keepalive: true })
    })
  })
})
