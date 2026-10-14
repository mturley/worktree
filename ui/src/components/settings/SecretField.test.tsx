import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { CredResult } from "../../api/types"
import { SecretField } from "./SecretField"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(cleanup)

describe("SecretField", () => {
  it("shows set state with no value, and Test", async () => {
    const onTest = vi.fn()
    wrap(<SecretField label="Token" description="d" isSet onReplace={vi.fn()} onTest={onTest} test={{ status: "idle" }} />)
    const input = screen.getByLabelText("Token")
    expect(input).toHaveValue("")
    expect(input).toHaveAttribute("placeholder", expect.stringMatching(/set/))
    await userEvent.click(screen.getByRole("button", { name: "Test" }))
    expect(onTest).toHaveBeenCalledOnce()
  })

  it("disables Test when not set", () => {
    wrap(<SecretField label="Token" description="d" isSet={false} onReplace={vi.fn()} onTest={vi.fn()} test={{ status: "idle" }} />)
    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled()
  })

  it("focus offers Replace and Cancel; Replace is disabled until typed", async () => {
    wrap(<SecretField label="Token" description="d" isSet onReplace={vi.fn()} />)
    await userEvent.click(screen.getByLabelText("Token"))
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled()
    await userEvent.type(screen.getByLabelText("Token"), "abc")
    expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByLabelText("Token")).toHaveValue("")
    expect(screen.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument()
  })

  it("on success clears the value and shows Saved", async () => {
    const onReplace = vi.fn().mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    wrap(<SecretField label="Token" description="d" isSet onReplace={onReplace} />)
    await userEvent.type(screen.getByLabelText("Token"), "new-secret")
    await userEvent.click(screen.getByRole("button", { name: "Replace" }))
    await waitFor(() => expect(onReplace).toHaveBeenCalledWith("new-secret"))
    expect(await screen.findByText(/Saved/)).toBeInTheDocument()
    expect(screen.getByLabelText("Token")).toHaveValue("")
    expect(screen.queryByDisplayValue("new-secret")).not.toBeInTheDocument()
  })

  it("on refusal keeps the value and explains nothing was saved", async () => {
    const onReplace = vi.fn().mockResolvedValue({ ok: false, kind: "auth", detail: "401 Bad credentials" })
    wrap(<SecretField label="Token" description="d" isSet onReplace={onReplace} />)
    await userEvent.type(screen.getByLabelText("Token"), "bad")
    await userEvent.click(screen.getByRole("button", { name: "Replace" }))
    expect(await screen.findByText(/401 Bad credentials/)).toHaveTextContent(/Nothing was saved/)
    expect(screen.getByLabelText("Token")).toHaveValue("bad")
  })

  it("renders test chips", () => {
    const done = (result: CredResult) => (
      <MantineProvider>
        <SecretField label="T" description="d" isSet onReplace={vi.fn()} onTest={vi.fn()} test={{ status: "done", at: Date.now(), result }} />
      </MantineProvider>
    )
    const { rerender } = wrap(<SecretField label="T" description="d" isSet onReplace={vi.fn()} onTest={vi.fn()} test={{ status: "testing" }} />)
    expect(screen.getByText(/Testing/)).toBeInTheDocument()
    rerender(done({ ok: false, kind: "network", detail: "timeout" }))
    expect(screen.getByText(/Couldn't reach/)).toBeInTheDocument()
    const detail = "Save the Jira host first, or Replace the token to test it with the new host."
    rerender(done({ ok: false, kind: "unsaved", detail }))
    const chip = screen.getByText("Save host first")
    expect(chip.closest("[title]")).toHaveAttribute("title", detail)
  })
})
