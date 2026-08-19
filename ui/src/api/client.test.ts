import { describe, it, expect, vi, afterEach } from "vitest"
import { api } from "./client"

afterEach(() => vi.restoreAllMocks())

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
