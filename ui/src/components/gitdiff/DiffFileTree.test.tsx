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

  it("marks the selected file", () => {
    setup([f("a.go"), f("b.go")], "b.go")
    expect(screen.getByTestId("tree-file-b.go")).toHaveAttribute("data-active", "true")
    expect(screen.getByTestId("tree-file-a.go")).not.toHaveAttribute("data-active")
  })
})
