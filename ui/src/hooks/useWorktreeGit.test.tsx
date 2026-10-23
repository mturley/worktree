import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useWorktreeGit } from "./useWorktreeGit"
import type { WorktreeGit } from "../api/types"

const worktreeGit = vi.fn()
vi.mock("../api/client", () => ({ api: { worktreeGit: (...a: unknown[]) => worktreeGit(...a) } }))

const git = { on_disk: true, branch: "b" } as WorktreeGit

describe("useWorktreeGit", () => {
  it("keeps the previous data while the fetch flag flips, so the badge does not blink", async () => {
    let release!: () => void
    worktreeGit.mockResolvedValueOnce(git)
    worktreeGit.mockImplementationOnce(() => new Promise((r) => { release = () => r(git) }))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result, rerender } = renderHook(({ fetch }) => useWorktreeGit("/wt/a", { fetch }), {
      wrapper,
      initialProps: { fetch: false },
    })
    await waitFor(() => expect(result.current.data).toBe(git))

    rerender({ fetch: true })
    // The new query is still loading, yet the old data stays on screen.
    expect(worktreeGit).toHaveBeenLastCalledWith("/wt/a", true)
    expect(result.current.data).toBe(git)
    release()
  })
})
