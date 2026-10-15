import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { OpenInEditorButton } from "./OpenInEditorButton"
import { baseSettings } from "./settings/testSettings"

function withEditor(editor: string) {
  const s = baseSettings()
  s.worktree.editor = editor
  return s
}

function renderButton() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <MantineProvider><OpenInEditorButton path="/wt/one" /></MantineProvider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("OpenInEditorButton", () => {
  it("names the configured editor and opens the worktree in it", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(withEditor("code"))
    const open = vi.spyOn(api, "openInEditor").mockResolvedValue({ ok: true })
    renderButton()
    const button = await screen.findByRole("button", { name: /^Open in editor \(\s*code\s*\)$/ })
    expect(button).toBeEnabled()
    await userEvent.click(button)
    await waitFor(() => expect(open).toHaveBeenCalledWith("/wt/one"))
  })

  it("is disabled with a pointer to Settings when no editor is configured", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(withEditor(""))
    renderButton()
    const button = await screen.findByRole("button", { name: "Open in editor" })
    expect(button).toBeDisabled()
    await waitFor(() => expect(api.settings).toHaveBeenCalled())
    await userEvent.hover(button.parentElement!)
    expect(await screen.findByText(/Settings → General/)).toBeInTheDocument()
  })

  it("shows why opening failed", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(withEditor("nope"))
    vi.spyOn(api, "openInEditor").mockRejectedValue(new Error("starting nope: executable file not found"))
    renderButton()
    await userEvent.click(await screen.findByRole("button", { name: /^Open in editor \(\s*nope\s*\)$/ }))
    expect(await screen.findByText(/Couldn't open: starting nope/)).toBeInTheDocument()
  })
})
