import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BlocksSection } from "./BlocksSection"
import { detail, renderDetail } from "./detailsTestUtils"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: { taskDetail: vi.fn() },
}))

beforeEach(() => {
  window.history.replaceState({}, "", "/?task=1")
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("BlocksSection", () => {
  it("lists the tasks this one blocks and opens one in place of this", async () => {
    const user = userEvent.setup()
    const before = window.history.length
    renderDetail(
      detail({
        blocks: [
          { id: 7, ref: "T7", title: "Release notes", state: "in_progress" },
          { id: 8, ref: "T8", title: "Shipped thing", state: "done" },
        ],
      }),
      (d) => <BlocksSection task={d} />,
    )
    expect(screen.getByRole("heading", { name: "Blocks" })).toBeInTheDocument()
    const row = screen.getByRole("button", { name: /T7 Release notes/ })
    expect(screen.getByRole("button", { name: /T8 Shipped thing/ })).toBeInTheDocument()
    await user.click(row)
    expect(new URLSearchParams(window.location.search).get("task")).toBe("7")
    expect(window.history.length).toBe(before)
  })

  it("says so when it blocks nothing", () => {
    renderDetail(detail(), (d) => <BlocksSection task={d} />)
    expect(screen.getByText("Blocks no other tasks.")).toBeInTheDocument()
  })
})
