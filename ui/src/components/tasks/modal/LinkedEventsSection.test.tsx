import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { api } from "../../../api/client"
import type { TaskEventLink, TaskEventSnapshot, TimelineEvent } from "../../../api/types"
import { LinkedEventsSection } from "./LinkedEventsSection"
import { detail, renderDetail } from "./detailsTestUtils"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: { taskDetail: vi.fn(), unlinkTaskEvent: vi.fn() },
}))

const snap: TaskEventSnapshot = {
  source: "github", type: "pr_comment", title: "Snapshot title", author: "alice", body: "said a thing",
  url: "https://github.com/o/r/pull/1#c1", ts: "2026-10-20T00:00:00Z", resource_type: "pr", resource_id: "o/r#1",
}
const live: TimelineEvent = {
  id: "7", ts: "2026-10-20T00:00:00Z", external_ts: "", source: "github", type: "pr_comment", type_label: "",
  title: "Live title", body: "", author: "alice", resource_type: "pr", resource_id: "o/r#1",
  resource_url: "", resource_title: "", worktrees: [],
}

const links: TaskEventLink[] = [
  { key: "ev:6", snapshot: snap },
  { key: "ev:7", snapshot: { ...snap, title: "Old title" }, live },
]
const base = detail({ event_links: links })

beforeEach(() => {
  vi.mocked(api.taskDetail).mockResolvedValue(base)
  vi.mocked(api.unlinkTaskEvent).mockResolvedValue(detail())
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const show = () => renderDetail(base, (d) => <LinkedEventsSection task={d} />)

describe("LinkedEventsSection", () => {
  it("renders from the snapshot when there is no live event", () => {
    show()
    expect(screen.getByText("Snapshot title")).toBeInTheDocument()
    expect(screen.getByText("said a thing")).toBeInTheDocument()
    const row = screen.getByText("Snapshot title").closest("[data-event-row]")
    expect(row).toHaveTextContent("alice")
  })

  it("prefers the live event when there is one", () => {
    show()
    expect(screen.getByText("Live title")).toBeInTheDocument()
    expect(screen.queryByText("Old title")).toBeNull()
  })

  it("Open goes to the event's URL in a new tab", () => {
    show()
    const open = screen.getAllByRole("link", { name: "Open" })[0]
    expect(open).toHaveAttribute("href", snap.url)
    expect(open).toHaveAttribute("target", "_blank")
  })

  it("rows are not in-app navigation", () => {
    show()
    // EventRow renders a button only when it has somewhere to go.
    expect(document.querySelector("[data-event-row][data-clickable]")).toBeNull()
  })

  it("unlinks", async () => {
    const user = userEvent.setup()
    show()
    vi.mocked(api.taskDetail).mockResolvedValue(detail())
    await user.click(screen.getByRole("button", { name: "Unlink event: Snapshot title" }))
    expect(api.unlinkTaskEvent).toHaveBeenCalledWith(1, "ev:6")
    expect(await screen.findByText("No linked events.")).toBeInTheDocument()
  })
})
