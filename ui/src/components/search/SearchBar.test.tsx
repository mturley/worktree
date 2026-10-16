import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider, Modal } from "@mantine/core"
import { useState } from "react"
import { SearchBar } from "./SearchBar"

function Harness({ initial = "", extra }: { initial?: string; extra?: React.ReactNode }) {
  const [q, setQ] = useState(initial)
  return (
    <MantineProvider>
      <SearchBar value={q} onChange={setQ} />
      <span data-testid="q">{q}</span>
      {extra}
    </MantineProvider>
  )
}
afterEach(cleanup)

describe("SearchBar", () => {
  it("types into the query", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oauth")
    expect(screen.getByTestId("q").textContent).toBe("oauth")
  })
  it("/ focuses the bar from the page, but not from another input", async () => {
    render(<Harness extra={<input data-testid="other" />} />)
    await userEvent.keyboard("/")
    expect(screen.getByRole("searchbox")).toHaveFocus()
    screen.getByTestId("other").focus()
    await userEvent.keyboard("/")
    expect(screen.getByTestId("other")).toHaveFocus()
  })
  it("Esc in the bar clears, a second Esc blurs", async () => {
    render(<Harness initial="oauth" />)
    const box = screen.getByRole("searchbox")
    box.focus()
    await userEvent.keyboard("{Escape}")
    expect(screen.getByTestId("q").textContent).toBe("")
    expect(box).toHaveFocus()
    await userEvent.keyboard("{Escape}")
    expect(box).not.toHaveFocus()
  })
  it("Esc on the page clears the query", () => {
    render(<Harness initial="oauth" />)
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByTestId("q").textContent).toBe("")
  })
  it("Esc in another input leaves the query", () => {
    render(<Harness initial="oauth" extra={<textarea data-testid="composer" />} />)
    const c = screen.getByTestId("composer")
    c.focus()
    fireEvent.keyDown(c, { key: "Escape" })
    expect(screen.getByTestId("q").textContent).toBe("oauth")
  })
  it("Esc with a modal open leaves the query", () => {
    render(<Harness initial="oauth" extra={<Modal opened onClose={vi.fn()} title="m">body</Modal>} />)
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByTestId("q").textContent).toBe("oauth")
  })
  it("the clear button clears", async () => {
    render(<Harness initial="oauth" />)
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(screen.getByTestId("q").textContent).toBe("")
  })
})
