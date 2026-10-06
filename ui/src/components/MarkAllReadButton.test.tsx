import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ResourceDTO } from "../api/types"

const markResourceRead = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api, markResourceRead: (...args: unknown[]) => markResourceRead(...args) } }
})
const markThreadRead = vi.fn()
vi.mock("../api/slackApi", async (orig) => ({
  ...(await orig<typeof import("../api/slackApi")>()),
  markRead: (...args: unknown[]) => markThreadRead(...args),
}))

import { MarkAllReadButton } from "./MarkAllReadButton"

const pr = (id: string, n: number, through?: string): ResourceDTO =>
  ({ type: "pr", id, url: "u", primary: true, unread_count: n, unread_through_ts: through }) as ResourceDTO
const jira = (id: string, n: number, through?: string): ResourceDTO =>
  ({ type: "jira", id, url: "u", primary: true, unread_count: n, unread_through_ts: through }) as ResourceDTO
const slack = (id: string, n: number, latest = "1790000000.000100"): ResourceDTO =>
  ({ type: "slack", id, url: "u", primary: false, has_unread: n > 0, unread_count: n, updated_ts: latest }) as ResourceDTO

const wrap = (items: ResourceDTO[]) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarkAllReadButton resources={items} />
      </QueryClientProvider>
    </MantineProvider>,
  )

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /mark all read/i }))
  await screen.findByRole("dialog")
}

// Braces, not an expression body: vitest calls a function RETURNED from
// beforeEach as teardown, and mockReset returns the mock itself.
beforeEach(() => {
  markResourceRead.mockReset()
  markResourceRead.mockResolvedValue(null)
  markThreadRead.mockReset()
  markThreadRead.mockResolvedValue(undefined)
})
afterEach(cleanup)

const everything = () => [
  pr("o/r#1", 2, "2099-01-02T00:00:00Z"),
  pr("o/r#2", 1, "2099-01-03T00:00:00Z"),
  pr("o/r#3", 0),
  jira("J-1", 3, "2099-01-05T00:00:00Z"),
  jira("J-2", 1, "2099-01-06T00:00:00Z"),
  slack("C1:1.2", 5, "1790000000.000100"),
  slack("C2:3.4", 7, "1790000009.000900"),
  slack("C3:5.6", 0),
]

describe("MarkAllReadButton", () => {
  it("renders nothing when nothing is unread", () => {
    wrap([pr("o/r#1", 0), jira("J-1", 0), slack("C1:1.2", 0)])
    expect(screen.queryByRole("button", { name: /mark all read/i })).not.toBeInTheDocument()
  })

  it("lists each type with unreads, with its own counts, all checked", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    for (const name of [
      "Mark 3 GitHub events as read across 2 PRs",
      "Mark 4 Jira events as read across 2 issues",
      "Mark 12 Slack messages as read across 2 threads",
    ]) {
      expect(screen.getByRole("checkbox", { name })).toBeChecked()
    }
  })

  it("lists only the types that have unreads", async () => {
    const user = userEvent.setup()
    wrap([pr("o/r#1", 0), jira("J-1", 3, "2099-01-05T00:00:00Z"), slack("C1:1.2", 0)])
    await open(user)
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
    expect(screen.getByRole("checkbox", { name: "Mark 3 Jira events as read across 1 issue" })).toBeInTheDocument()
  })

  it("uses singular forms", async () => {
    const user = userEvent.setup()
    wrap([pr("o/r#1", 1, "2099-01-02T00:00:00Z"), jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", 1)])
    await open(user)
    for (const name of [
      "Mark 1 GitHub event as read across 1 PR",
      "Mark 1 Jira event as read across 1 issue",
      "Mark 1 Slack message as read across 1 thread",
    ]) {
      expect(screen.getByRole("checkbox", { name })).toBeInTheDocument()
    }
  })

  it("marks everything listed, each through what was shown", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(markResourceRead).toHaveBeenCalledTimes(4))
    expect(markResourceRead).toHaveBeenCalledWith({ type: "pr", id: "o/r#1", through_ts: "2099-01-02T00:00:00Z" })
    expect(markResourceRead).toHaveBeenCalledWith({ type: "pr", id: "o/r#2", through_ts: "2099-01-03T00:00:00Z" })
    expect(markResourceRead).toHaveBeenCalledWith({ type: "jira", id: "J-1", through_ts: "2099-01-05T00:00:00Z" })
    expect(markResourceRead).toHaveBeenCalledWith({ type: "jira", id: "J-2", through_ts: "2099-01-06T00:00:00Z" })
    expect(markThreadRead).toHaveBeenCalledTimes(2)
    expect(markThreadRead).toHaveBeenCalledWith("C1", "1.2", "1790000000.000100")
    expect(markThreadRead).toHaveBeenCalledWith("C2", "3.4", "1790000009.000900")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("skips a type that is unchecked", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    await user.click(screen.getByRole("checkbox", { name: /GitHub/ }))
    await user.click(screen.getByRole("checkbox", { name: /Slack/ }))
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(markResourceRead).toHaveBeenCalledTimes(2))
    expect(markResourceRead.mock.calls.every(([a]) => (a as { type: string }).type === "jira")).toBe(true)
    expect(markThreadRead).not.toHaveBeenCalled()
  })

  it("disables Mark read with nothing checked", async () => {
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", 2)])
    await open(user)
    await user.click(screen.getByRole("checkbox", { name: /Jira/ }))
    await user.click(screen.getByRole("checkbox", { name: /Slack/ }))
    expect(screen.getByRole("button", { name: "Mark read" })).toBeDisabled()
  })

  it("starts fully checked again on the next open", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    await user.click(screen.getByRole("checkbox", { name: /Slack/ }))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await open(user)
    expect(screen.getByRole("checkbox", { name: /Slack/ })).toBeChecked()
  })

  it("sends nothing on cancel", async () => {
    const user = userEvent.setup()
    wrap(everything())
    await open(user)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(markResourceRead).not.toHaveBeenCalled()
    expect(markThreadRead).not.toHaveBeenCalled()
  })

  it("skips resources missing the timestamp to mark through", async () => {
    // Never guess at a cursor: an older server's resource without
    // unread_through_ts, or a thread never polled to an updated_ts, is left
    // out of both the counts and the writes.
    const user = userEvent.setup()
    const unpolled = { ...slack("C9:9.9", 4), updated_ts: undefined } as ResourceDTO
    wrap([jira("J-1", 2, "2099-01-05T00:00:00Z"), jira("J-2", 9), unpolled])
    await open(user)
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
    expect(screen.getByRole("checkbox", { name: "Mark 2 Jira events as read across 1 issue" })).toBeInTheDocument()
  })

  it("keeps the modal open and shows the error when a write fails", async () => {
    markResourceRead.mockImplementation(() => Promise.reject(new Error("boom")))
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
    await open(user)
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
