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
  it("Enter with nothing highlighted closes the dropdown and keeps the query", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa{Enter}")
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(picks.a).not.toHaveBeenCalled()
    expect(screen.getByRole("searchbox")).toHaveValue("oa")
  })
  it("first Esc closes the dropdown, not the query", async () => {
    render(<Harness />)
    await userEvent.type(screen.getByRole("searchbox"), "oa")
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(screen.getByRole("searchbox")).toHaveValue("oa")
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
