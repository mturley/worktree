import { describe, it, expect, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { ArchivedToggle } from "./ArchivedToggle"

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>)
}

describe("ArchivedToggle", () => {
  it("renders the switch with its label and reflects the checked value", () => {
    const { container } = renderWithProvider(<ArchivedToggle value={false} onChange={() => {}} />)
    expect(container.textContent).toContain("Show archived")
    const input = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.checked).toBe(false)
  })

  it("calls onChange with the new value when toggled", () => {
    const onChange = vi.fn()
    const { container } = renderWithProvider(<ArchivedToggle value={false} onChange={onChange} />)
    const input = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    input.click()
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it("wraps the switch in a tooltip with the archived-events explanation", async () => {
    renderWithProvider(<ArchivedToggle value={true} onChange={() => {}} />)
    // Mantine's Tooltip only mounts its floating content once the wrapped
    // element is hovered. Hover the visible label, as a user does: a Tooltip
    // that listened on Switch's hidden <input> passed a test hovering the
    // input but never opened in a browser.
    await userEvent.hover(screen.getByText("Show archived"))

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Include activity from resources that are no longer being followed by a worktree",
      )
    })
  })
})
