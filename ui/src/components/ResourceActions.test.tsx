import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import type { CmuxTreeResponse, ResourceDTO } from "../api/types"
import { ResourceActions, openLabel } from "./ResourceActions"

const wrap = (ui: React.ReactNode) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
    </MantineProvider>,
  )
const res = (over: Partial<ResourceDTO>): ResourceDTO =>
  ({ type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, ...over }) as ResourceDTO

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("openLabel", () => {
  it("uses the preposition that reads right per destination", () => {
    // "on" for the sites you open a page on, "in" for the app you open a
    // conversation in.
    expect(openLabel("pr")).toBe("Open on GitHub")
    expect(openLabel("jira")).toBe("Open on Jira")
    expect(openLabel("slack")).toBe("Open in Slack")
  })

  it("falls back to a generic label for an unknown type", () => {
    expect(openLabel("weird")).toBe("Open")
  })
})

describe("ResourceActions", () => {
  it("links to the resource url", () => {
    wrap(<ResourceActions r={res({})} />)
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", "https://gh/pr/1")
  })

  it("copies the url and shows feedback", async () => {
    // userEvent.setup() installs its own clipboard stub, so ours must be
    // applied AFTER it or it gets clobbered.
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    wrap(<ResourceActions r={res({})} />)
    await user.click(screen.getByRole("button", { name: /copy link/i }))
    expect(writeText).toHaveBeenCalledWith("https://gh/pr/1")
    expect(await screen.findByLabelText("Copy link")).toBeInTheDocument()
  })

  it("renders nothing when the resource has no url", () => {
    // MantineProvider injects a <style> element, so assert on the controls
    // rather than on the container being textually empty.
    wrap(<ResourceActions r={res({ url: "" })} />)
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /copy link/i })).not.toBeInTheDocument()
  })

  it("marks the group so the segment dividers apply", () => {
    // The divider is drawn by .compound-group in cards.css. A previous
    // attempt keyed off a data-position attribute Mantine never emits, so
    // the segments ran together with no visible divider; assert on the hook
    // the stylesheet actually uses.
    const { container } = wrap(<ResourceActions r={res({})} />)
    const group = container.querySelector(".compound-group")
    expect(group).not.toBeNull()
    expect(group!.children.length).toBeGreaterThan(1)
  })
})

describe("ResourceActions in cmux", () => {
  const PR_URL = "https://github.com/org/repo/pull/5"
  const pr = res({ url: PR_URL })
  const jira = res({ type: "jira", id: "PROJ-1", url: "https://acme.atlassian.net/browse/PROJ-1" })
  const treeWith = (url: string): CmuxTreeResponse => ({
    available: true,
    workspaces: [{
      id: "W1", ref: "workspace:1", title: "wt", selected: true,
      panes: [{ ref: "pane:1", focused: true, tabs: [{ ref: "surface:7", title: "PR", type: "browser", url, selected: false }] }],
    }],
  })

  it("keeps the plain link when no tab shows the resource", async () => {
    const tree = vi.spyOn(api, "cmuxTree").mockResolvedValue(treeWith("https://github.com/org/repo/pull/6"))
    wrap(<ResourceActions r={pr} path="/wt" />)
    await waitFor(() => expect(tree).toHaveBeenCalledWith("/wt"))
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", PR_URL)
    expect(screen.queryByRole("button", { name: /more open options/i })).not.toBeInTheDocument()
  })

  it("does not ask cmux without a path or for other resource types", () => {
    const tree = vi.spyOn(api, "cmuxTree")
    wrap(<ResourceActions r={pr} />)
    wrap(<ResourceActions r={res({ type: "slack", url: "https://x.slack.com/archives/C/p1" })} path="/wt" />)
    expect(tree).not.toHaveBeenCalled()
  })

  it("switches to the existing tab, with a new-tab option in the menu", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(treeWith("https://acme.atlassian.net/browse/PROJ-1?x=1"))
    const focus = vi.spyOn(api, "cmuxFocusTab").mockResolvedValue({ ok: true })
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    const user = userEvent.setup()
    wrap(<ResourceActions r={jira} path="/wt" />)

    await user.click(await screen.findByRole("button", { name: "Switch to open Jira tab" }))
    expect(focus).toHaveBeenCalledWith("W1", "surface:7")
    expect(open).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: /more open options/i }))
    expect(await screen.findByRole("menuitem", { name: "Open on Jira (new tab)" })).toHaveAttribute(
      "href",
      "https://acme.atlassian.net/browse/PROJ-1",
    )
  })

  it("opens a new tab when cmux cannot focus the old one", async () => {
    vi.spyOn(api, "cmuxTree").mockResolvedValue(treeWith(PR_URL + "/files"))
    vi.spyOn(api, "cmuxFocusTab").mockResolvedValue({ ok: false, error: "gone" })
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    const user = userEvent.setup()
    wrap(<ResourceActions r={pr} path="/wt" />)

    await user.click(await screen.findByRole("button", { name: "Switch to open GitHub tab" }))
    await waitFor(() => expect(open).toHaveBeenCalledWith(PR_URL, "_blank", "noreferrer"))
  })
})
