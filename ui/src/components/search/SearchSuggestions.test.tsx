import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { useState } from "react"
import { SearchBar, type Suggestion } from "./SearchBar"

const picks = { a: vi.fn(), b: vi.fn() }
const items: Suggestion[] = [
  { key: "a", group: "Worktrees", label: "oauth-fix", onPick: picks.a },
  { key: "b", group: "Resources", label: "OAuth first", onPick: picks.b },
]
function Harness() {
  const [q, setQ] = useState("")
  return <MantineProvider><SearchBar value={q} onChange={setQ} suggestions={q ? items : []} /></MantineProvider>
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe("dropdown", () => {
  it("shows grouped rows while typing", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa")
    expect(screen.getByRole("listbox")).toBeInTheDocument()
    expect(screen.getByText("Worktrees")).toBeInTheDocument()
    expect(screen.getAllByRole("option")).toHaveLength(2)
  })
  it("arrow keys move and Enter picks", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa")
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}")
    expect(picks.b).toHaveBeenCalled()
  })
  it("counts no-row-highlighted as a stop when cycling with the arrows", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa")
    const selected = () => screen.queryAllByRole("option").findIndex((o) => o.getAttribute("aria-selected") === "true")
    await userEvent.keyboard("{ArrowDown}")
    expect(selected()).toBe(0)
    await userEvent.keyboard("{ArrowUp}")
    expect(selected()).toBe(-1)
    await userEvent.keyboard("{ArrowUp}")
    expect(selected()).toBe(1)
    await userEvent.keyboard("{ArrowDown}")
    expect(selected()).toBe(-1)
  })

  it("offers View all results, with the Enter hint only while no row is highlighted", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa")
    expect(screen.getByTestId("view-all-enter")).toBeInTheDocument()
    await userEvent.keyboard("{ArrowDown}")
    expect(screen.queryByTestId("view-all-enter")).toBeNull()
    expect(screen.getByRole("button", { name: "View all results" })).toBeInTheDocument()
  })

  it("View all results closes the dropdown and keeps the query", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa")
    await userEvent.click(screen.getByRole("button", { name: "View all results" }))
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(screen.getByRole("searchbox")).toHaveValue("oa")
    expect(picks.a).not.toHaveBeenCalled()
  })

  it("hints at the arrow keys, and marks the highlighted row with Enter", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa")
    expect(screen.getByTestId("nav-hint").textContent).toBe("↑↓ to navigate")
    expect(screen.queryByTestId("row-enter")).toBeNull()
    await userEvent.keyboard("{ArrowDown}{ArrowDown}")
    const options = screen.getAllByRole("option")
    expect(options[1]).toContainElement(screen.getByTestId("row-enter"))
    expect(screen.getAllByTestId("row-enter")).toHaveLength(1)
  })

  it("still opens with no results, saying nothing matches", async () => {
    function Empty() {
      const [q, setQ] = useState("")
      return <MantineProvider><SearchBar value={q} onChange={setQ} suggestions={[]} /></MantineProvider>
    }
    render(<Empty />)
    await userEvent.type(screen.getByRole("searchbox"), "zz")
    const empty = screen.getByText("Nothing matches your search")
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    // The hint bar still heads it; only the arrow hint, with no rows, goes.
    const hint = screen.getByText(/The page is also filtered as you type/)
    expect(hint.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole("button", { name: "View all results" })).toBeInTheDocument()
    expect(screen.queryByTestId("nav-hint")).toBeNull()
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByText("Nothing matches your search")).toBeNull()
  })

  it("Enter with nothing highlighted closes the dropdown and keeps the query", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa{Enter}")
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(picks.a).not.toHaveBeenCalled()
    expect(screen.getByRole("searchbox")).toHaveValue("oa")
  })
  it("Esc with the dropdown open clears the search, which closes it", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa")
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(screen.getByRole("searchbox")).toHaveValue("")
  })
  it("clicking a row picks it", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa")
    await userEvent.click(screen.getByText("OAuth first"))
    expect(picks.b).toHaveBeenCalled()
    expect(screen.queryByRole("listbox")).toBeNull()
  })
  it("Enter after the suggestions shrink does not pick a stale row", async () => {
    const Live = ({ list }: { list: Suggestion[] }) => {
      const [q, setQ] = useState("")
      return <MantineProvider><SearchBar value={q} onChange={setQ} suggestions={q ? list : []} /></MantineProvider>
    }
    const { rerender } = render(<Live list={items} />)
    await userEvent.type(screen.getByRole("searchbox"), "oa")
    await userEvent.keyboard("{ArrowDown}{ArrowDown}")
    rerender(<Live list={[items[0]]} />)
    await userEvent.keyboard("{Enter}")
    expect(picks.b).not.toHaveBeenCalled()
  })
})
