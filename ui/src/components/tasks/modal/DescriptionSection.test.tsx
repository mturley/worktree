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
  sessionStorage.clear()
})

const DRAFT = "task-description-draft:1"

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

  it("reports whether the description has unsaved edits", async () => {
    const onDirty = vi.fn()
    const user = userEvent.setup()
    renderDetail(detail({ description: "old" }), (t) => <DescriptionSection task={t} onDirtyChange={onDirty} />)
    await user.click(screen.getByRole("button", { name: "Edit description" }))
    // Opening the editor changes nothing yet.
    expect(onDirty).not.toHaveBeenCalledWith(true)
    await user.type(screen.getByRole("textbox", { name: "Description" }), "!")
    expect(onDirty).toHaveBeenLastCalledWith(true)
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onDirty).toHaveBeenLastCalledWith(false)
  })

  it("keeps an unsaved draft for the task, and restores it when shown again", async () => {
    const user = userEvent.setup()
    const first = renderDetail(detail({ description: "old" }), (t) => <DescriptionSection task={t} />)
    await user.click(screen.getByRole("button", { name: "Edit description" }))
    await user.type(screen.getByRole("textbox", { name: "Description" }), " draft")
    expect(sessionStorage.getItem(DRAFT)).toBe("old draft")
    // Lost the way Back loses it: the modal unmounts without asking.
    first.unmount()

    renderDetail(detail({ description: "old" }), (t) => <DescriptionSection task={t} />)
    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("old draft")
    expect(screen.getByText("Unsaved draft restored")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(sessionStorage.getItem(DRAFT)).toBeNull()
    expect(screen.queryByText("Unsaved draft restored")).toBeNull()
  })

  it("a save clears the kept draft", async () => {
    vi.mocked(api.updateTask).mockResolvedValue(detail({ description: "old!" }))
    vi.mocked(api.taskDetail).mockResolvedValue(detail({ description: "old!" }))
    const user = userEvent.setup()
    renderDetail(detail({ description: "old" }), (t) => <DescriptionSection task={t} />)
    await user.click(screen.getByRole("button", { name: "Edit description" }))
    await user.type(screen.getByRole("textbox", { name: "Description" }), "!")
    expect(sessionStorage.getItem(DRAFT)).toBe("old!")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull())
    expect(sessionStorage.getItem(DRAFT)).toBeNull()
  })

  it("ignores a kept draft that matches the description", () => {
    sessionStorage.setItem(DRAFT, "same")
    renderDetail(detail({ description: "same" }), (t) => <DescriptionSection task={t} />)
    expect(screen.queryByRole("textbox", { name: "Description" })).toBeNull()
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
