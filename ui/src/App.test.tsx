import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

vi.mock("./pages/HomePage", () => ({ HomePage: () => <div>home page</div> }))
vi.mock("./pages/WorktreeDetailPage", () => ({ WorktreeDetailPage: () => <div>detail page</div> }))
vi.mock("./components/HomeWorktreeBanner", () => ({ HomeWorktreeBanner: () => null }))
// vi.mock factories are hoisted above this file's declarations, so the spy
// must be hoisted with them.
const { sse } = vi.hoisted(() => ({ sse: vi.fn() }))
vi.mock("./hooks/useSSE", () => ({ useSSE: () => sse() }))

import { App } from "./App"
import { LOGIN_REQUIRED_EVENT } from "./api/client"

type Reply = { status: number; body: unknown }
const LOGIN_REQUIRED = { "X-Worktree-Login-Required": "1" }

// routes maps "METHOD /path" to a function producing the reply.
function mockServer(routes: Record<string, () => Reply>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`
    const r = routes[key]?.() ?? { status: 404, body: { error: `unmocked ${key}` } }
    return {
      ok: r.status < 400,
      status: r.status,
      headers: new Headers(r.status === 401 ? LOGIN_REQUIRED : {}),
      json: async () => r.body,
    } as unknown as Response
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const session = { handle: "h1", label: "Mac — Chrome", created_at: "", last_seen_at: "", current: true }

const renderApp = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider><App /></MantineProvider>
    </QueryClientProvider>,
  )

beforeEach(() => {
  window.history.replaceState({}, "", "/")
  sse.mockClear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("App authentication gate", () => {
  it("shows the login screen, and opens no event stream, without a session", async () => {
    mockServer({ "GET /api/session": () => ({ status: 401, body: { error: "login required" } }) })
    renderApp()
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument()
    expect(screen.queryByText("home page")).not.toBeInTheDocument()
    expect(sse).not.toHaveBeenCalled()
  })

  it("shows the app with a session", async () => {
    mockServer({ "GET /api/session": () => ({ status: 200, body: session }) })
    renderApp()
    expect(await screen.findByText("home page")).toBeInTheDocument()
    expect(sse).toHaveBeenCalled()
  })

  it("shows the server's message for a wrong password", async () => {
    mockServer({
      "GET /api/session": () => ({ status: 401, body: { error: "login required" } }),
      "POST /api/login": () => ({ status: 401, body: { error: "incorrect password" } }),
    })
    renderApp()
    await userEvent.type(await screen.findByLabelText("Password"), "nope")
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))
    expect(await screen.findByText("incorrect password")).toBeInTheDocument()
  })

  it("enters the app after a correct password, keeping the URL", async () => {
    window.history.replaceState({}, "", "/worktree/%2Fwt%2Ffoo")
    let loggedIn = false
    mockServer({
      "GET /api/session": () => (loggedIn ? { status: 200, body: session } : { status: 401, body: { error: "login required" } }),
      "POST /api/login": () => { loggedIn = true; return { status: 200, body: session } },
    })
    renderApp()
    await userEvent.type(await screen.findByLabelText("Password"), "right")
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))
    expect(await screen.findByText("detail page")).toBeInTheDocument()
  })

  it("returns to the login screen when a request reports the session gone", async () => {
    let loggedIn = true
    mockServer({
      "GET /api/session": () => (loggedIn ? { status: 200, body: session } : { status: 401, body: { error: "login required" } }),
    })
    renderApp()
    await screen.findByText("home page")
    loggedIn = false
    act(() => { window.dispatchEvent(new Event(LOGIN_REQUIRED_EVENT)) })
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument()
  })

  it("offers a retry when the server cannot be reached", async () => {
    let up = false
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (!up) throw new TypeError("Failed to fetch")
      return { ok: true, status: 200, headers: new Headers(), json: async () => session } as unknown as Response
    }))
    renderApp()
    const retry = await screen.findByRole("button", { name: "Retry" })
    up = true
    await userEvent.click(retry)
    expect(await screen.findByText("home page")).toBeInTheDocument()
  })
})
