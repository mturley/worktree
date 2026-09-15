import { describe, it, expect, vi, afterEach } from "vitest"
import { api, HttpError, LOGIN_REQUIRED_EVENT, reportIfLoginRequired } from "./client"

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

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { ok: status < 400, status, headers: new Headers(headers), json: async () => body } as unknown as Response
}

describe("login-required handling", () => {
  it("dispatches the login-required event for a marked 401 and throws HttpError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      response(401, { error: "login required" }, { "X-Worktree-Login-Required": "1" }),
    ))
    const listener = vi.fn()
    window.addEventListener(LOGIN_REQUIRED_EVENT, listener)
    try {
      const err = await api.worktrees().catch((e) => e)
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).status).toBe(401)
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(LOGIN_REQUIRED_EVENT, listener)
    }
  })

  it("does not treat an unmarked 401 as a login prompt", () => {
    const listener = vi.fn()
    window.addEventListener(LOGIN_REQUIRED_EVENT, listener)
    try {
      expect(reportIfLoginRequired(response(401, {}))).toBe(false)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(LOGIN_REQUIRED_EVENT, listener)
    }
  })

  it("never dispatches from the session or login calls, which would loop", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      response(401, { error: "login required" }, { "X-Worktree-Login-Required": "1" }),
    ))
    const listener = vi.fn()
    window.addEventListener(LOGIN_REQUIRED_EVENT, listener)
    try {
      await expect(api.session()).rejects.toBeInstanceOf(HttpError)
      await expect(api.login("x")).rejects.toBeInstanceOf(HttpError)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(LOGIN_REQUIRED_EVENT, listener)
    }
  })

  it("POSTs the password to /api/login", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { handle: "h" }))
    vi.stubGlobal("fetch", fetchMock)
    await api.login("pw")
    expect(fetchMock).toHaveBeenCalledWith("/api/login", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    }))
  })

  it("POSTs the handle to /api/sessions/revoke", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    await api.revokeSession("abc")
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/revoke", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ handle: "abc" }),
    }))
  })
})
