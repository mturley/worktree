import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { setViewport } from "../testing/viewport"
import { api } from "../api/client"
import { HomeHeader } from "./HomeHeader"

afterEach(cleanup)
afterEach(() => vi.restoreAllMocks())

const wrap = () => {
  vi.spyOn(api, "cmux").mockResolvedValue({ available: true })
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <HomeHeader search={<input aria-label="Search" />} unreadOnly={false} onUnreadOnlyChange={() => {}} hasUnread={false} />
      </MantineProvider>
    </QueryClientProvider>,
  )
}

describe("HomeHeader layering", () => {
  it("sits at the app chrome layer, like the sticky headers, so content tooltips pass under it", () => {
    setViewport("wide")
    wrap()
    const h = screen.getByTestId("home-header")
    expect(h.style.position).toBe("relative")
    expect(h.style.zIndex).toBe("var(--mantine-z-index-app)")
    expect(h.style.background).toBe("var(--mantine-color-body)")
  })
})

describe("HomeHeader", () => {
  it("holds the logo, search, global toggles and settings", async () => {
    setViewport("wide")
    wrap()
    const h = screen.getByTestId("home-header")
    expect(within(h).getByRole("heading", { name: "Worktrees" })).toBeInTheDocument()
    expect(within(h).getByLabelText("Search")).toBeInTheDocument()
    expect(within(h).getByRole("switch", { name: "Unreads only" })).toBeInTheDocument()
    expect(await within(h).findByRole("switch", { name: "Follow cmux" })).toBeInTheDocument()
    expect(within(h).getByRole("button", { name: "Settings" })).toBeInTheDocument()
  })

  it("puts the toggles on a second, full-width row when narrow", async () => {
    setViewport("narrow")
    wrap()
    const h = screen.getByTestId("home-header")
    const settings = within(h).getByRole("button", { name: "Settings" })
    const unread = within(h).getByRole("switch", { name: "Unreads only" })
    expect(settings.compareDocumentPosition(unread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The toggles' row is its own direct child of the header, not the search row.
    const row = Array.from(h.children).find((c) => c.contains(unread)) as HTMLElement
    expect(row.contains(settings)).toBe(false)
    expect(row.contains(within(h).getByLabelText("Search"))).toBe(false)
    expect(row.style.width).toBe("100%")
    expect(await within(h).findByRole("switch", { name: "Follow cmux" })).toBeInTheDocument()
  })
})
