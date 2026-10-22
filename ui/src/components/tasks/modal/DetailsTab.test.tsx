import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, screen } from "@testing-library/react"
import { DetailsTab } from "./DetailsTab"
import { detail, renderDetail } from "./detailsTestUtils"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: { taskDetail: vi.fn(), worktrees: vi.fn().mockResolvedValue([]) },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("DetailsTab", () => {
  it("shows Description, Subtasks, Linked to and Linked events, in that order", () => {
    renderDetail(detail(), (t) => <DetailsTab task={t} />)
    const headings = screen.getAllByRole("heading").map((h) => h.textContent)
    expect(headings).toEqual(["Description", "Subtasks", "Linked to", "Linked events"])
  })
})
