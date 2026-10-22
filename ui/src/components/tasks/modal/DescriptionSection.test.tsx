import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { api } from "../../../api/client"
import { DescriptionSection } from "./DescriptionSection"
import { detail, renderDetail } from "./detailsTestUtils"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: { taskDetail: vi.fn(), updateTask: vi.fn() },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("DescriptionSection", () => {
  it("renders the description as markdown", () => {
    renderDetail(detail({ description: "hello **world**" }), (t) => <DescriptionSection task={t} />)
    expect(screen.getByText("world").tagName).toBe("STRONG")
  })

  it("says so when there is none", () => {
    renderDetail(detail(), (t) => <DescriptionSection task={t} />)
    expect(screen.getByText("No description.")).toBeInTheDocument()
  })

  it("Edit switches to a textarea, and Save writes and shows the result", async () => {
    vi.mocked(api.updateTask).mockResolvedValue(detail({ description: "new *text*" }))
    vi.mocked(api.taskDetail).mockResolvedValue(detail({ description: "new *text*" }))
    const user = userEvent.setup()
    renderDetail(detail({ description: "old" }), (t) => <DescriptionSection task={t} />)
    await user.click(screen.getByRole("button", { name: "Edit description" }))
    const box = screen.getByRole("textbox", { name: "Description" })
    expect(box).toHaveValue("old")
    await user.clear(box)
    await user.type(box, "new *text*")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(api.updateTask).toHaveBeenCalledWith(1, { description: "new *text*" })
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull())
    expect(screen.getByText("text").tagName).toBe("EM")
  })

  it("Cancel discards the edit", async () => {
    const user = userEvent.setup()
    renderDetail(detail({ description: "old" }), (t) => <DescriptionSection task={t} />)
    await user.click(screen.getByRole("button", { name: "Edit description" }))
    await user.type(screen.getByRole("textbox", { name: "Description" }), " more")
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull()
    expect(screen.getByText("old")).toBeInTheDocument()
    expect(api.updateTask).not.toHaveBeenCalled()
  })

  it("a failed save keeps the editor and the text, and says why", async () => {
    vi.mocked(api.updateTask).mockRejectedValue(new Error("boom"))
    vi.mocked(api.taskDetail).mockResolvedValue(detail({ description: "old" }))
    const user = userEvent.setup()
    renderDetail(detail({ description: "old" }), (t) => <DescriptionSection task={t} />)
    await user.click(screen.getByRole("button", { name: "Edit description" }))
    await user.type(screen.getByRole("textbox", { name: "Description" }), " more")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("old more")
  })
})
