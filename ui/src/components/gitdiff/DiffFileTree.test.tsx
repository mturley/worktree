import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { DiffFileTree, type TreeFile } from "./DiffFileTree"

const f = (path: string, additions = 3, deletions = 1): TreeFile => ({ path, additions, deletions, binary: false })

const setup = (files: TreeFile[], selected: string | null = null) => {
  const onSelect = vi.fn()
  render(
    <MantineProvider>
      <DiffFileTree files={files} selected={selected} onSelect={onSelect} />
    </MantineProvider>,
  )
  return { onSelect }
}

describe("DiffFileTree", () => {
  it("compacts a single-child directory chain into one node", () => {
    setup([f("internal/webui/a.go"), f("internal/webui/b.go")])
    expect(screen.getByText("internal/webui")).toBeInTheDocument()
    expect(screen.queryByText("internal")).not.toBeInTheDocument()
    expect(screen.queryByText("webui")).not.toBeInTheDocument()
    expect(screen.getByText("a.go")).toBeInTheDocument()
    expect(screen.getByText("b.go")).toBeInTheDocument()
  })

  it("keeps a directory with several children as its own node", () => {
    setup([f("ui/src/a.ts"), f("ui/README.md")])
    expect(screen.getByText("ui")).toBeInTheDocument()
    expect(screen.getByText("src")).toBeInTheDocument()
    expect(screen.getByText("README.md")).toBeInTheDocument()
  })

  it("shows each file's additions and deletions", () => {
    setup([f("a.go", 12, 4)])
    const row = screen.getByTestId("tree-file-a.go")
    expect(row).toHaveTextContent("+12")
    expect(row).toHaveTextContent("−4")
  })

  it("calls onSelect with the file's path when a file is clicked", async () => {
    const { onSelect } = setup([f("internal/webui/a.go"), f("internal/webui/b.go")])
    await userEvent.click(screen.getByText("b.go"))
    expect(onSelect).toHaveBeenCalledWith("internal/webui/b.go")
  })

  it("does not select anything when a directory is clicked", async () => {
    const { onSelect } = setup([f("internal/webui/a.go"), f("internal/webui/b.go")])
    await userEvent.click(screen.getByText("internal/webui"))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("starts with every directory open when the files arrive after mounting", () => {
    // The view mounts the tree before the patch loads, so its first data is empty.
    const { rerender } = render(
      <MantineProvider>
        <DiffFileTree files={[]} selected={null} onSelect={() => {}} />
      </MantineProvider>,
    )
    rerender(
      <MantineProvider>
        <DiffFileTree files={[f("ui/src/a.ts"), f("ui/README.md"), f("internal/webui/b.go")]} selected={null} onSelect={() => {}} />
      </MantineProvider>,
    )
    expect(screen.getByTestId("tree-file-ui/src/a.ts")).toBeInTheDocument()
    expect(screen.getByTestId("tree-file-ui/README.md")).toBeInTheDocument()
    expect(screen.getByTestId("tree-file-internal/webui/b.go")).toBeInTheDocument()
  })

  it("keeps a folded directory folded when the files change", async () => {
    const files = [f("ui/src/a.ts"), f("ui/README.md")]
    const { rerender } = render(
      <MantineProvider>
        <DiffFileTree files={files} selected={null} onSelect={() => {}} />
      </MantineProvider>,
    )
    await userEvent.click(screen.getByText("src"))
    expect(screen.queryByTestId("tree-file-ui/src/a.ts")).not.toBeInTheDocument()
    rerender(
      <MantineProvider>
        <DiffFileTree files={[...files, f("go.mod")]} selected={null} onSelect={() => {}} />
      </MantineProvider>,
    )
    expect(screen.queryByTestId("tree-file-ui/src/a.ts")).not.toBeInTheDocument()
    expect(screen.getByTestId("tree-file-go.mod")).toBeInTheDocument()
  })

  it("leaves file rows Mantine's per-level indent", () => {
    setup([f("ui/src/a.ts"), f("ui/README.md")])
    // Mantine indents a row's label with padding-inline-start:
    // var(--label-offset), set per level on its <li>; an inline padding on
    // the row would override it.
    const row = screen.getByTestId("tree-file-ui/README.md")
    expect(row.closest("li")).toHaveAttribute("data-level", "2")
    expect(row.style.paddingLeft).toBe("")
    expect(row.style.paddingInlineStart).toBe("")
    expect(row.style.paddingInline).toBe("")
  })

  it("marks the selected file", () => {
    setup([f("a.go"), f("b.go")], "b.go")
    expect(screen.getByTestId("tree-file-b.go")).toHaveAttribute("data-active", "true")
    expect(screen.getByTestId("tree-file-a.go")).not.toHaveAttribute("data-active")
  })
})
