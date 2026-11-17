import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const apiMock = vi.hoisted(() => ({
  worktreeGit: vi.fn(async (_path: string, _fetch: boolean) => ({
    status: "clean",
    branch: "main",
    tracking: null,
    main_upstream_ref: null,
    base_remote: null,
    pr_id: null,
    head_sha: "abc",
    merge_base_sha: null,
    vs_merge_base: null,
    vs_tracking: null,
    working: null,
    fingerprint: "F1",
    working_fingerprint: "W1",
  })),
}))
vi.mock("../api/client", () => ({ api: apiMock }))

import { useWorktreeGit } from "./useWorktreeGit"

function Probe({ path, fetch }: { path: string; fetch: boolean }) {
  useWorktreeGit(path, { fetch })
  return null
}

describe("useWorktreeGit", () => {
  beforeEach(() => {
    apiMock.worktreeGit.mockClear()
  })

  it("shares one request between fetch and non-fetch observers", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    function Harness() {
      return (
        <QueryClientProvider client={client}>
          <Probe path="/wt" fetch={false} />
          <Probe path="/wt" fetch={true} />
        </QueryClientProvider>
      )
    }

    render(<Harness />)

    await waitFor(() => expect(apiMock.worktreeGit).toHaveBeenCalled())
    expect(apiMock.worktreeGit).toHaveBeenCalledTimes(1)
    expect(apiMock.worktreeGit).toHaveBeenCalledWith("/wt", true)
  })

  it("asks without fetch when no observer wants it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    function Harness() {
      return (
        <QueryClientProvider client={client}>
          <Probe path="/wt" fetch={false} />
        </QueryClientProvider>
      )
    }

    render(<Harness />)

    await waitFor(() => expect(apiMock.worktreeGit).toHaveBeenCalled())
    expect(apiMock.worktreeGit).toHaveBeenCalledWith("/wt", false)
  })

  it("refetches with fetch as soon as a fetch observer mounts", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    function Harness({ mountFetch }: { mountFetch: boolean }) {
      return (
        <QueryClientProvider client={client}>
          <Probe path="/wt" fetch={false} />
          {mountFetch && <Probe path="/wt" fetch={true} />}
        </QueryClientProvider>
      )
    }

    const { rerender } = render(<Harness mountFetch={false} />)
    await waitFor(() => expect(apiMock.worktreeGit).toHaveBeenCalledTimes(1))
    expect(apiMock.worktreeGit).toHaveBeenCalledWith("/wt", false)

    rerender(<Harness mountFetch={true} />)

    await waitFor(() => expect(apiMock.worktreeGit).toHaveBeenCalledTimes(2))
    expect(apiMock.worktreeGit).toHaveBeenLastCalledWith("/wt", true)
  })

  it("stops asking for fetch after the fetch observer unmounts", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    function Harness({ mountFetch }: { mountFetch: boolean }) {
      return (
        <QueryClientProvider client={client}>
          <Probe path="/wt" fetch={false} />
          {mountFetch && <Probe path="/wt" fetch={true} />}
        </QueryClientProvider>
      )
    }

    const { rerender } = render(<Harness mountFetch={true} />)
    await waitFor(() => expect(apiMock.worktreeGit).toHaveBeenCalledTimes(1))
    expect(apiMock.worktreeGit).toHaveBeenCalledWith("/wt", true)

    rerender(<Harness mountFetch={false} />)

    await waitFor(() => {
      expect(client.getQueryCache().find({ queryKey: ["worktree-git", "/wt"] })).toBeTruthy()
    })
    await client.refetchQueries({ queryKey: ["worktree-git", "/wt"] })

    await waitFor(() => expect(apiMock.worktreeGit).toHaveBeenLastCalledWith("/wt", false))
  })
})
