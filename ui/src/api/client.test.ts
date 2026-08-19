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
