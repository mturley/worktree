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
