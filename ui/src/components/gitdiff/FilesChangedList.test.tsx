import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { FileChange } from "../../api/types"
import { FilesChangedList } from "./FilesChangedList"

const editor = vi.hoisted(() => ({ value: "code" }))

vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return {
    api: {
      ...actual.api,
      settings: async () => ({ worktree: { editor: editor.value } }),
      openInEditor: vi.fn(async () => ({ ok: true })),
    },
  }
})

const file = (path: string, over: Partial<FileChange> = {}): FileChange => ({
  path,
  status: "M",
  additions: 3,
  deletions: 1,
  binary: false,
  ...over,
})

const setup = (files: FileChange[], onOpenFile = vi.fn(), onViewDiff = vi.fn()) => {
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <FilesChangedList path="/w/a" files={files} onOpenFile={onOpenFile} onViewDiff={onViewDiff} />
      </QueryClientProvider>
    </MantineProvider>,
  )
  return { onOpenFile, onViewDiff }
}

describe("FilesChangedList", () => {
  it("renders glyph, editor icon, path and counts in order, sorted by path", async () => {
    setup([file("b/z.go"), file("a/y.go", { status: "A", additions: 128, deletions: 0 })])
    const rows = screen.getAllByTestId("file-row")
    expect(rows.map((r) => r.textContent)).toEqual(["Aa/y.go+128 −0", "Mb/z.go+3 −1"])
    const first = rows[0]
    const cells = Array.from(first.children)
    expect(cells[0]).toHaveTextContent("A")
    expect(cells[1].querySelector("button[aria-label^='Open']")).not.toBeNull()
    expect(cells[2]).toHaveTextContent("a/y.go")
    expect(cells[3]).toHaveTextContent("+128 −0")
  })

  it("shows renames as old → new and binary files as binary", () => {
    setup([file("new.png", { status: "R", old_path: "old.png", binary: true, additions: 0, deletions: 0 })])
    expect(screen.getByText("old.png → new.png")).toBeInTheDocument()
    expect(screen.getByText("binary")).toBeInTheDocument()
  })

  it("disables the editor icon for a deleted file", async () => {
    setup([file("gone.go", { status: "D" }), file("here.go")])
    await waitFor(() => expect(screen.getByRole("button", { name: "Open here.go in editor" })).toBeEnabled())
    expect(screen.getByRole("button", { name: "Open gone.go in editor" })).toBeDisabled()
  })

  it("drills into the diff at a file when its path is clicked", async () => {
    const user = userEvent.setup()
    const { onOpenFile } = setup([file("x/y.go")])
    await user.click(screen.getByRole("button", { name: "x/y.go" }))
    expect(onOpenFile).toHaveBeenCalledWith("x/y.go")
  })

  it("caps the rows at 200", async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 250 }, (_, i) => file(`f${String(i).padStart(3, "0")}.go`))
    const { onViewDiff } = setup(many)
    expect(screen.getAllByTestId("file-row")).toHaveLength(200)
    expect(screen.getByText(/and 50 more/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "View diff" }))
    expect(onViewDiff).toHaveBeenCalled()
  })

  it("names the configured editor in the icon's tooltip", async () => {
    editor.value = "code"
    const user = userEvent.setup()
    setup([file("x.go")])
    // The icon swaps out of its disabled wrapper once settings load, so look it up again.
    const icon = () => screen.getByRole("button", { name: "Open x.go in editor" })
    await waitFor(() => expect(icon()).toBeEnabled())
    await user.hover(icon())
    expect(await screen.findByText("Open in code (configure editor in settings)")).toBeInTheDocument()
  })

  it("asks for an editor when none is configured", async () => {
    editor.value = ""
    const user = userEvent.setup()
    setup([file("x.go")])
    const icon = screen.getByRole("button", { name: "Open x.go in editor" })
    expect(icon).toBeDisabled()
    await user.hover(icon.parentElement!)
    expect(await screen.findByText("Configure an editor in settings")).toBeInTheDocument()
  })
})
