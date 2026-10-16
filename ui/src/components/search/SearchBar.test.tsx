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

describe("SearchBar escape hatch", () => {
  it("Esc on the page calls onEscape when there's something else to clear, even with no query", () => {
    const onEscape = vi.fn()
    render(<MantineProvider><SearchBar value="" onChange={() => {}} onEscape={onEscape} escapeActive /></MantineProvider>)
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })
  it("Esc still works with focus on a switch or checkbox, which aren't text fields", () => {
    const onEscape = vi.fn()
    render(
      <MantineProvider>
        <SearchBar value="" onChange={() => {}} onEscape={onEscape} escapeActive />
        <input type="checkbox" data-testid="switch" />
      </MantineProvider>,
    )
    const box = screen.getByTestId("switch")
    box.focus()
    fireEvent.keyDown(box, { key: "Escape" })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it("does nothing when there's nothing to clear", () => {
    const onEscape = vi.fn()
    render(<MantineProvider><SearchBar value="" onChange={() => {}} onEscape={onEscape} escapeActive={false} /></MantineProvider>)
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(onEscape).not.toHaveBeenCalled()
  })
  it("Esc in the bar calls onEscape too, then blurs on the next press", async () => {
    const onEscape = vi.fn()
    const { rerender } = render(
      <MantineProvider><SearchBar value="oauth" onChange={() => {}} onEscape={onEscape} escapeActive /></MantineProvider>,
    )
    const box = screen.getByRole("searchbox")
    box.focus()
    await userEvent.keyboard("{Escape}")
    expect(onEscape).toHaveBeenCalledTimes(1)
    rerender(<MantineProvider><SearchBar value="" onChange={() => {}} onEscape={onEscape} escapeActive={false} /></MantineProvider>)
    await userEvent.keyboard("{Escape}")
    expect(box).not.toHaveFocus()
  })
})

describe("SearchBar", () => {
  it("turns off browser autocorrect, autocapitalize, autocomplete and spellcheck", () => {
    render(<Harness />)
    const box = screen.getByRole("searchbox")
    expect(box).toHaveAttribute("autocorrect", "off")
    expect(box).toHaveAttribute("autocapitalize", "off")
    expect(box).toHaveAttribute("autocomplete", "off")
    expect(box).toHaveAttribute("spellcheck", "false")
  })

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
  it("hidden listboxes do not block global Esc", () => {
    render(
      <Harness
        initial="oauth"
        extra={
          <>
            <div role="listbox" hidden />
            <div role="listbox" style={{ display: "none" }} />
            <div aria-hidden="true">
              <div role="menu" />
            </div>
          </>
        }
      />,
    )
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByTestId("q").textContent).toBe("")
  })
  it("a visible menu blocks global Esc", () => {
    render(<Harness initial="oauth" extra={<div role="menu" />} />)
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByTestId("q").textContent).toBe("oauth")
  })
  it("an already-handled Esc does not clear", () => {
    render(<Harness initial="oauth" />)
    const stop = (e: KeyboardEvent) => e.preventDefault()
    document.body.addEventListener("keydown", stop)
    fireEvent.keyDown(document.body, { key: "Escape" })
    document.body.removeEventListener("keydown", stop)
    expect(screen.getByTestId("q").textContent).toBe("oauth")
  })
  it("the clear button clears", async () => {
    render(<Harness initial="oauth" />)
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(screen.getByTestId("q").textContent).toBe("")
  })
})
