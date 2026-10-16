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
        <HomeHeader search={<input aria-label="Search" />} unreadOnly={false} onUnreadOnlyChange={() => {}} />
      </MantineProvider>
    </QueryClientProvider>,
  )
}

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
})
