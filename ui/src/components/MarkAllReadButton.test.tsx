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

import { MarkAllReadButton } from "./MarkAllReadButton"

const pr = (id: string, n: number, through?: string): ResourceDTO =>
  ({ type: "pr", id, url: "u", primary: true, unread_count: n, unread_through_ts: through }) as ResourceDTO
const jira = (id: string, n: number, through?: string): ResourceDTO =>
  ({ type: "jira", id, url: "u", primary: true, unread_count: n, unread_through_ts: through }) as ResourceDTO
const slack = (id: string, unread: boolean): ResourceDTO =>
  ({ type: "slack", id, url: "u", primary: false, has_unread: unread }) as ResourceDTO

const wrap = (items: ResourceDTO[]) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarkAllReadButton resources={items} />
      </QueryClientProvider>
    </MantineProvider>,
  )

beforeEach(() => { markResourceRead.mockReset(); markResourceRead.mockResolvedValue(null) })
afterEach(cleanup)

describe("MarkAllReadButton", () => {
  it("renders nothing when no GitHub/Jira resource has unread events", () => {
    // An unread Slack thread alone is not enough: this button cannot clear it.
    wrap([pr("o/r#1", 0), slack("C1:1.2", true)])
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

  it("notes that unread Slack threads are left alone", async () => {
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", true)])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    expect(await screen.findByText(/slack threads are not affected/i)).toBeInTheDocument()
  })

  it("omits the Slack note when no thread is unread", async () => {
    const user = userEvent.setup()
    wrap([jira("J-1", 1, "2099-01-05T00:00:00Z"), slack("C1:1.2", false)])
    await user.click(screen.getByRole("button", { name: /mark all read/i }))
    await screen.findByText("Mark 1 event read across 1 resource?")
    expect(screen.queryByText(/slack threads are not affected/i)).not.toBeInTheDocument()
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
