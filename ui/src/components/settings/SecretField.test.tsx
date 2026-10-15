import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { CredResult } from "../../api/types"
import { SecretField, VALID_FLASH_MS } from "./SecretField"

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

  it("a passing test flashes ✓ Valid on the button, then reverts to Test", () => {
    vi.useFakeTimers()
    try {
      const field = (test: React.ComponentProps<typeof SecretField>["test"]) => (
        <MantineProvider><SecretField label="Token" description="d" isSet onReplace={vi.fn()} onTest={vi.fn()} test={test} /></MantineProvider>
      )
      const { rerender } = render(field({ status: "testing" }))
      rerender(field({ status: "done", at: 1, result: { ok: true, kind: "ok", detail: "" } }))
      expect(screen.getByRole("button", { name: "✓ Valid" })).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(VALID_FLASH_MS) })
      expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument()
      // A failed test never flashes.
      rerender(field({ status: "done", at: 2, result: { ok: false, kind: "auth", detail: "no" } }))
      expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
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

  it("on success clears the input; the parent holds the value", async () => {
    const onReplace = vi.fn().mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    wrap(<SecretField label="Token" description="d" isSet onReplace={onReplace} />)
    await userEvent.type(screen.getByLabelText("Token"), "new-secret")
    await userEvent.click(screen.getByRole("button", { name: "Replace" }))
    await waitFor(() => expect(onReplace).toHaveBeenCalledWith("new-secret"))
    await waitFor(() => expect(screen.getByLabelText("Token")).toHaveValue(""))
    expect(screen.queryByDisplayValue("new-secret")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument()
  })

  it("a pending value shows Unsaved and swaps Test for Revert", async () => {
    const onRevert = vi.fn()
    wrap(<SecretField label="Token" description="d" isSet pending onRevert={onRevert} onReplace={vi.fn()} onTest={vi.fn()} test={{ status: "idle" }} />)
    expect(screen.getByText("Unsaved")).toBeInTheDocument()
    expect(screen.getByLabelText("Token")).toHaveAttribute("placeholder", expect.stringMatching(/unsaved/))
    expect(screen.queryByRole("button", { name: "Test" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Revert" }))
    expect(onRevert).toHaveBeenCalledOnce()
  })

  it("on refusal keeps the typed value and says it was not kept", async () => {
    const onReplace = vi.fn().mockResolvedValue({ ok: false, kind: "auth", detail: "401 Bad credentials" })
    wrap(<SecretField label="Token" description="d" isSet onReplace={onReplace} />)
    await userEvent.type(screen.getByLabelText("Token"), "bad")
    await userEvent.click(screen.getByRole("button", { name: "Replace" }))
    expect(await screen.findByText(/401 Bad credentials/)).toHaveTextContent(/The new value was not kept/)
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
