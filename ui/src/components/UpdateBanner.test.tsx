import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { UpdateBanner } from "./UpdateBanner"
import { api } from "../api/client"

const DETAILS = "https://github.com/mturley/worktree/commits/main"
const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <UpdateBanner />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

beforeEach(() => vi.restoreAllMocks())
afterEach(cleanup)

describe("UpdateBanner", () => {
  it("announces an available update with a link to the commits", async () => {
    vi.spyOn(api, "updateStatus").mockResolvedValue({ available: true, behind_by: 2, details_url: DETAILS })
    wrap()
    expect(await screen.findByText(/new updates are available/i)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /see details on github/i })).toHaveAttribute("href", DETAILS)
  })

  it("renders nothing when up to date", async () => {
    const spy = vi.spyOn(api, "updateStatus").mockResolvedValue({ available: false, behind_by: 0, details_url: DETAILS })
    wrap()
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText(/new updates are available/i)).not.toBeInTheDocument()
  })

  it("can be dismissed", async () => {
    vi.spyOn(api, "updateStatus").mockResolvedValue({ available: true, behind_by: 1, details_url: DETAILS })
    wrap()
    await userEvent.click(await screen.findByRole("button", { name: /dismiss/i }))
    expect(screen.queryByText(/new updates are available/i)).not.toBeInTheDocument()
  })
})
