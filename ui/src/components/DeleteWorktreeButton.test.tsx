import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { DeleteWorktreeButton } from "./DeleteWorktreeButton"
import type { WorktreeSummary } from "../api/types"

vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      worktreeInfo: async () => ({
        env: [],
        git: { branch: "my-branch", upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0 },
      }),
    },
  }
})

const w = { path: "/wt/foo", repo: "odh", branch: "my-branch", on_disk: true } as WorktreeSummary

const wrap = () =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DeleteWorktreeButton w={w} />
      </QueryClientProvider>
    </MantineProvider>,
  )

describe("DeleteWorktreeButton", () => {
  it("opens the delete modal from the trash control", async () => {
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("button", { name: /delete worktree/i }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    // The typed-name confirmation is the safeguard; it must be present.
    expect(screen.getByLabelText(/type the worktree name/i)).toBeInTheDocument()
  })

  it("does not delete anything just by opening the modal", async () => {
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("button", { name: /delete worktree/i }))
    expect(await screen.findByRole("button", { name: /^delete$/i })).toBeDisabled()
  })
})
