import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Modal } from "@mantine/core"
import { api } from "../../../api/client"
import { LogWorkButton } from "./LogWorkButton"
import { detail, renderDetail } from "./detailsTestUtils"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: { taskDetail: vi.fn(), logWork: vi.fn(), editWorkLog: vi.fn(), deleteWorkLog: vi.fn() },
}))

const base = detail()

beforeEach(() => {
  vi.mocked(api.taskDetail).mockResolvedValue(base)
  vi.mocked(api.logWork).mockResolvedValue(base)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const open = async () => {
  const user = userEvent.setup()
  await user.click(await screen.findByRole("button", { name: "Log work" }))
  const box = await screen.findByRole("textbox")
  return { user, box }
}

describe("LogWorkButton", () => {
  it("opens a popover with a focused textarea", async () => {
    renderDetail(base, (t) => <LogWorkButton taskId={t.id} />)
    const { box } = await open()
    await waitFor(() => expect(box).toHaveFocus())
  })

  it("disables Save while the text is blank", async () => {
    renderDetail(base, (t) => <LogWorkButton taskId={t.id} />)
    const { user, box } = await open()
    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()
    await user.type(box, "   ")
    expect(save).toBeDisabled()
    await user.type(box, "x")
    expect(save).toBeEnabled()
  })

  it("saves on Ctrl+Enter and closes", async () => {
    renderDetail(base, (t) => <LogWorkButton taskId={t.id} />)
    const { user, box } = await open()
    await user.type(box, "did a thing")
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(api.logWork).toHaveBeenCalledWith(1, "did a thing"))
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull())
  })

  it("closes on Escape without closing an enclosing modal", async () => {
    const onClose = vi.fn()
    renderDetail(base, (t) => (
      <Modal opened onClose={onClose}>
        <LogWorkButton taskId={t.id} />
      </Modal>
    ))
    const { user } = await open()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull())
    expect(onClose).not.toHaveBeenCalled()
    expect(api.logWork).not.toHaveBeenCalled()
  })

  it("keeps the text and shows the error when saving fails", async () => {
    vi.mocked(api.logWork).mockRejectedValue(new Error("boom"))
    renderDetail(base, (t) => <LogWorkButton taskId={t.id} />)
    const { user, box } = await open()
    await user.type(box, "keep me")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveValue("keep me")
  })
})
