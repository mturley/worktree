import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { LinkedItem } from "../../api/types"
import { LinkedActionsContext } from "./LinkedActionsContext"
import { LinkedResourceRow } from "./LinkedResourceRow"

const item = (over: Partial<LinkedItem> = {}): LinkedItem =>
  ({ type: "jira", id: "PROJ-9", url: "https://example.atlassian.net/browse/PROJ-9", resolved: true, title: "Story", ...over })

function wrap(ui: React.ReactNode) {
  vi.spyOn(api, "cmuxBrowserTabs").mockResolvedValue({ available: false, tabs: [] })
  return render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <LinkedActionsContext.Provider value={{ requestFollow: vi.fn(), trackedResource: () => null }}>{ui}</LinkedActionsContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  )
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("LinkedResourceRow context", () => {
  it("shows the surrounding text under the row, with the label linking to the item", () => {
    wrap(<LinkedResourceRow item={item({ context: { before: "Follow-up to", label: "the parent story", after: "which shipped" } })} />)
    const line = screen.getByTestId("link-context")
    expect(line).toHaveTextContent("Follow-up to the parent story which shipped")
    const link = screen.getByRole("link", { name: "the parent story" })
    expect(link).toHaveAttribute("href", "https://example.atlassian.net/browse/PROJ-9")
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("adds no stray spaces when there is no before or after text", () => {
    wrap(<LinkedResourceRow item={item({ context: { before: "", label: "spec", after: "" } })} />)
    expect(screen.getByTestId("link-context").textContent).toBe("spec")
  })

  it("keeps punctuation against the link instead of spacing it off", () => {
    wrap(<LinkedResourceRow item={item({ context: { before: "details in (", label: "the spec", after: "), thanks" } })} />)
    expect(screen.getByTestId("link-context").textContent).toBe("details in (the spec), thanks")
  })

  it("renders nothing extra without context", () => {
    wrap(<LinkedResourceRow item={item()} />)
    expect(screen.queryByTestId("link-context")).toBeNull()
  })
})

describe("LinkedResourceRow layout", () => {
  it("puts the title on its own line, below the key, status and actions", () => {
    wrap(<LinkedResourceRow item={item({ status: "In Progress" })} />)
    const keyLine = screen.getByText("PROJ-9").closest(".mantine-Group-root")!
    expect(keyLine).toHaveTextContent("In Progress")
    expect(keyLine).not.toHaveTextContent("Story")
    expect(keyLine.compareDocumentPosition(screen.getByText("Story")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe("LinkedResourceRow status badge", () => {
  it("colours a Jira status and a PR state as the cards do", () => {
    wrap(<LinkedResourceRow item={item({ status: "Review" })} />)
    expect(screen.getByText("Review").closest(".mantine-Badge-root")!.getAttribute("style")).toContain("violet")
    cleanup()
    wrap(<LinkedResourceRow item={item({ type: "pr", id: "o/r#1", url: "https://github.com/o/r/pull/1", state: "MERGED", status: undefined })} />)
    expect(screen.getByText("merged").closest(".mantine-Badge-root")!.getAttribute("style")).toContain("violet")
  })
})
