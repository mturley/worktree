import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DiffRange } from "../api/types"

// Each call resolves only when the test says so, so the hook can be caught
// mid-load, which is when placeholder data shows.
const apiMock = vi.hoisted(() => ({
  pending: [] as { range: unknown; resolve: (v: unknown) => void }[],
}))
vi.mock("../api/client", () => ({
  api: {
    diffFiles: (_path: string, _base: string, range: unknown) =>
      new Promise((resolve) => apiMock.pending.push({ range, resolve })),
  },
}))

import { useDiffFiles } from "./useDiffData"

const answer = (name: string) => ({ fingerprint: "F", list_id: "L", files: [{ path: name }] })

function setup(initial: { range: DiffRange; fingerprint: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(
    ({ range, fingerprint }) => useDiffFiles("/wt", "merge-base", range, true, fingerprint),
    { wrapper, initialProps: initial },
  )
}

async function resolveNext(name: string) {
  await waitFor(() => expect(apiMock.pending.length).toBeGreaterThan(0))
  apiMock.pending.shift()!.resolve(answer(name))
}

describe("useDiffFiles", () => {
  it("keeps the previous files while a fingerprint poll reloads the same range", async () => {
    apiMock.pending = []
    const { result, rerender } = setup({ range: "all", fingerprint: "F1" })
    await resolveNext("old.go")
    await waitFor(() => expect(result.current.data?.files[0].path).toBe("old.go"))

    rerender({ range: "all", fingerprint: "F2" })
    expect(result.current.isPlaceholderData).toBe(true)
    expect(result.current.data?.files[0].path).toBe("old.go")
  })

  it("does not show the previous range's files under a new range", async () => {
    apiMock.pending = []
    const { result, rerender } = setup({ range: "all", fingerprint: "F1" })
    await resolveNext("old.go")
    await waitFor(() => expect(result.current.data?.files[0].path).toBe("old.go"))

    rerender({ range: { from: "c1", to: "c1" }, fingerprint: "F1" })
    expect(result.current.data).toBeUndefined()
    await resolveNext("new.go")
    await waitFor(() => expect(result.current.data?.files[0].path).toBe("new.go"))
  })

  it("keeps data across a fingerprint poll when the range is an equal but new object", async () => {
    apiMock.pending = []
    const { result, rerender } = setup({ range: { from: "c1", to: "c2" }, fingerprint: "F1" })
    await resolveNext("old.go")
    await waitFor(() => expect(result.current.data?.files[0].path).toBe("old.go"))

    rerender({ range: { from: "c1", to: "c2" }, fingerprint: "F2" })
    expect(result.current.data?.files[0].path).toBe("old.go")
  })
})
