import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api, HttpError } from "../api/client"
import type { CmuxPeek, CmuxTab } from "../api/types"
import { CmuxPeekCard } from "./CmuxPeekCard"

afterEach(() => vi.restoreAllMocks())

function show(tab: CmuxTab, peek: CmuxPeek | Error) {
  const spy = vi.spyOn(api, "cmuxPeek")
  if (peek instanceof Error) spy.mockRejectedValue(peek)
  else spy.mockResolvedValue(peek)
  const qc = new QueryClient()
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <CmuxPeekCard workspaceId="W" tab={tab} />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

const tab = (type: string, extra: Partial<CmuxTab> = {}): CmuxTab => ({ ref: "surface:1", title: `My ${type}`, type, selected: false, ...extra })

describe("CmuxPeekCard", () => {
  it("shows the title and URL as its header", () => {
    show(tab("browser", { url: "https://example.com/x" }), { type: "browser", image: "data:image/png;base64,UE5H" })
    expect(screen.getByText("My browser")).toBeInTheDocument()
    expect(screen.getByText("https://example.com/x")).toBeInTheDocument()
  })

  it("renders terminal text in a pre", async () => {
    show(tab("terminal"), { type: "terminal", text: "$ make test\nok" })
    const pre = await screen.findByTestId("cmux-peek-terminal")
    expect(pre.tagName).toBe("PRE")
    expect(pre).toHaveTextContent("$ make test")
  })

  it("renders a browser screenshot", async () => {
    show(tab("browser"), { type: "browser", image: "data:image/png;base64,UE5H" })
    const img = await screen.findByRole("img", { name: "My browser" })
    expect(img).toHaveAttribute("src", "data:image/png;base64,UE5H")
  })

  it("renders markdown with its path", async () => {
    show(tab("markdown"), { type: "markdown", markdown: "# Heading\n\nbody", path: "/tmp/notes.md" })
    expect(await screen.findByRole("heading", { name: "Heading" })).toBeInTheDocument()
    expect(screen.getByText("/tmp/notes.md")).toBeInTheDocument()
  })

  it("says so when there is nothing to peek at", async () => {
    show(tab("simulator"), { type: "simulator", unsupported: true })
    expect(await screen.findByText("No preview for this tab")).toBeInTheDocument()
  })

  it("shows a failed peek's error instead of loading forever", async () => {
    show(tab("terminal"), new HttpError("no such tab", 404))
    expect(await screen.findByText("no such tab")).toBeInTheDocument()
  })
})
