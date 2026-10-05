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
const slack = (id: string, unread: boolean, latest = "1790000000.000100"): ResourceDTO =>
  ({ type: "slack", id, url: "u", primary: false, has_unread: unread, updated_ts: latest }) as ResourceDTO

const wrap = (items: ResourceDTO[]) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarkAllReadButton resources={items} />
      </QueryClientProvider>
    </MantineProvider>,
  )

beforeEach(() => {
  markResourceRead.mockReset()
  markResourceRead.mockResolvedValue(null)
  markThreadRead.mockReset()
  markThreadRead.mockResolvedValue(undefined)
})
afterEach(cleanup)

describe("MarkAllReadButton", () => {
  it("renders nothing when nothing is unread", () => {
    wrap([pr("o/r#1", 0), slack("C1:1.2", false)])
    expect(screen.queryByRole("button", { name: /mark all read/i })).not.toBeInTheDocument()
  })

  it("asks to confirm, counting only the resources that have unreads", async () => {
    const user = userEvent.setup()
    wrap([pr("o/r#1", 2, "2099-01-02T00:00:00Z"), pr("o/r#2", 0), jira("J-1", 3, "2099-01-05T00:00:00Z")])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    expect(await screen.findByText("Mark 5 events read across 2 resources?")).toBeInTheDocument()
    expect(markResourceRead).not.toHaveBeenCalled()
  })

  it("uses singular forms for one event on one resource", async () => {
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    expect(await screen.findByText("Mark 1 event read across 1 resource?")).toBeInTheDocument()
  })

  it("offers to also mark unread Slack threads read, unchecked by default", async () => {
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", true), slack("C2:3.4", true), slack("C3:5.6", false)])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    const box = await screen.findByRole("checkbox", { name: "Also mark 2 Slack threads as read" })
    expect(box).not.toBeChecked()
  })

  it("uses the singular for one Slack thread", async () => {
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", true)])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    expect(await screen.findByRole("checkbox", { name: "Also mark 1 Slack thread as read" })).toBeInTheDocument()
  })

  it("has no Slack checkbox when no thread is unread", async () => {
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", false)])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    await screen.findByText("Mark 1 event read across 1 resource?")
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
  })

  it("leaves Slack alone unless the box is checked", async () => {
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", true)])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    await user.click(await screen.findByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(markResourceRead).toHaveBeenCalledTimes(1))
    expect(markThreadRead).not.toHaveBeenCalled()
  })

  it("marks each unread thread read through its latest message when checked", async () => {
    const user = userEvent.setup()
    wrap([
      jira("J-1", 1, "2099-01-05T00:00:00Z"),
      slack("C1:1.2", true, "1790000000.000100"),
      slack("C2:3.4", true, "1790000009.000900"),
      slack("C3:5.6", false),
    ])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    await user.click(await screen.findByRole("checkbox", { name: /also mark/i }))
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(markThreadRead).toHaveBeenCalledTimes(2))
    expect(markThreadRead).toHaveBeenCalledWith("C1", "1.2", "1790000000.000100")
    expect(markThreadRead).toHaveBeenCalledWith("C2", "3.4", "1790000009.000900")
    expect(markResourceRead).toHaveBeenCalledTimes(1)
  })

  it("asks only about Slack when only Slack threads are unread", async () => {
    // Nothing else to clear, so the threads ARE the action — no checkbox.
    const user = userEvent.setup()
    wrap([pr("o/r#1", 0), slack("C1:1.2", true), slack("C2:3.4", true)])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    expect(await screen.findByText("Mark 2 Slack threads read?")).toBeInTheDocument()
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(markThreadRead).toHaveBeenCalledTimes(2))
    expect(markResourceRead).not.toHaveBeenCalled()
  })

  it("marks each unread resource read through its own newest unread event", async () => {
    const user = userEvent.setup()
    wrap([pr("o/r#1", 2, "2099-01-02T00:00:00Z"), pr("o/r#2", 0), jira("J-1", 3, "2099-01-05T00:00:00Z")])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    await user.click(await screen.findByRole("button", { name: "Mark read" }))
    await waitFor(() => expect(markResourceRead).toHaveBeenCalledTimes(2))
    expect(markResourceRead).toHaveBeenCalledWith({ type: "pr", id: "o/r#1", through_ts: "2099-01-02T00:00:00Z" })
    expect(markResourceRead).toHaveBeenCalledWith({ type: "jira", id: "J-1", through_ts: "2099-01-05T00:00:00Z" })
    await waitFor(() =>
      expect(screen.queryByText(/events read across/)).not.toBeInTheDocument())
  })

  it("sends nothing on cancel", async () => {
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(markResourceRead).not.toHaveBeenCalled()
  })

  it("keeps the modal open and shows the error when a write fails", async () => {
    markResourceRead.mockImplementation(() => Promise.reject(new Error("boom")))
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z")])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    await user.click(await screen.findByRole("button", { name: "Mark read" }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(screen.getByText("Mark 1 event read across 1 resource?")).toBeInTheDocument()
  })
})
