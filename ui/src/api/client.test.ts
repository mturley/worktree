import { describe, it, expect, vi, afterEach } from "vitest"
import { api } from "./client"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("api.setResourceMeta", () => {
  it("POSTs the meta payload to /api/resource-meta", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => null })
    vi.stubGlobal("fetch", fetchMock)

    await api.setResourceMeta({ type: "slack", id: "C1:1", name: "n", description: "d" })

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/resource-meta",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "slack", id: "C1:1", name: "n", description: "d" }),
      }),
    )
  })
})

describe("api.addResource", () => {
  it("POSTs the url to /api/worktree-resources/add", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ type: "jira", id: "RHOAIENG-1" }) })
    vi.stubGlobal("fetch", fetchMock)
    await api.addResource({ path: "/w", url: "https://redhat.atlassian.net/browse/RHOAIENG-1" })
    expect(fetchMock).toHaveBeenCalledWith("/api/worktree-resources/add", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/w", url: "https://redhat.atlassian.net/browse/RHOAIENG-1" }),
    }))
  })
})

describe("api.removeResource", () => {
  it("POSTs type/id/path to /api/worktree-resources/remove", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => null })
    vi.stubGlobal("fetch", fetchMock)
    await api.removeResource({ path: "/w", type: "slack", id: "C1:1" })
    expect(fetchMock).toHaveBeenCalledWith("/api/worktree-resources/remove", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/w", type: "slack", id: "C1:1" }),
    }))
  })
})

function stubFetch() {
  const calls: string[] = []
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(url)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ events: [], next_cursor: "" }) } as Response)
  })
  return calls
}

describe("api.worktreeTimeline", () => {
  it("omits resource params when no resource is given", async () => {
    const calls = stubFetch()
    await api.worktreeTimeline("/wt/foo")
    expect(calls[0]).toContain("path=%2Fwt%2Ffoo")
    expect(calls[0]).not.toContain("resource_type")
  })

  it("sends encoded resource_type and resource_id when a resource is given", async () => {
    const calls = stubFetch()
    await api.worktreeTimeline("/wt/foo", 100, { type: "pr", id: "org/repo#1" })
    expect(calls[0]).toContain("resource_type=pr")
    expect(calls[0]).toContain("resource_id=org%2Frepo%231")
  })
})
