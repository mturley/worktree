import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WorktreeDetailCard } from "./WorktreeDetailCard"
import type { WorktreeInfo, WorktreeSummary } from "../api/types"

const worktreeInfo = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api, worktreeInfo: (...a: unknown[]) => worktreeInfo(...a) } }
})

const summary = (o: Partial<WorktreeSummary> = {}): WorktreeSummary => ({
  path: "/wt/foo", repo: "odh", branch: "my-branch", on_disk: true,
  resource_count: 2, primary_count: 1, latest_event_ts: "2026-08-25T00:00:00Z",
  primary_by_type: { pr: 1 }, related_count: 1,
  focus_resources: [
    { type: "pr", id: "o/r#1", url: "u", primary: true, title: "Focus PR title" },
  ],
  ...o,
}) as WorktreeSummary

const wrap = (w: WorktreeSummary) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <WorktreeDetailCard w={w} />
      </QueryClientProvider>
    </MantineProvider>,
  )

afterEach(() => { cleanup(); worktreeInfo.mockReset() })

const info = (o: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  env: [
    { key: "WORKTREE_PORTS", value: "4090-4099" },
    { key: "KUBECONFIG", value: "/home/u/.kube/config-foo" },
  ],
  git: { branch: "my-branch", upstream: "origin/my-branch", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0 },
  ...o,
})

describe("WorktreeDetailCard", () => {
  it("keeps the environment collapsed until asked", async () => {
    // These are long absolute paths that wrap to several lines each and push
    // the resource list and timeline below the fold. Note the assertion is
    // toBeVisible, NOT toBeInTheDocument: Mantine's Collapse keeps its
    // children mounted, so presence in the DOM proves nothing here.
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    const toggle = await screen.findByRole("button", { name: /show environment variables/i })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByText("4090-4099")).not.toBeVisible()
  })

  it("names how many variables there are, so the toggle is worth clicking", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    expect(await screen.findByText("Environment (2)")).toBeInTheDocument()
  })

  it("reveals the environment worktree info prints when expanded", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await userEvent.click(await screen.findByRole("button", { name: /show environment variables/i }))
    expect(screen.getByText("4090-4099")).toBeVisible()
    expect(screen.getByText("/home/u/.kube/config-foo")).toBeVisible()
  })

  it("collapses again on a second click", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await userEvent.click(await screen.findByRole("button", { name: /show environment/i }))
    await userEvent.click(screen.getByRole("button", { name: /hide environment/i }))
    expect(screen.getByText("4090-4099")).not.toBeVisible()
  })

  it("never lists focus resources, which the resource cards below already show", async () => {
    worktreeInfo.mockResolvedValue(info())
    wrap(summary())
    await screen.findByText("Environment (2)")
    expect(screen.queryByText("Focus PR title")).not.toBeInTheDocument()
  })

  it("summarises a dirty tree, counting staged/modified/untracked separately", async () => {
    worktreeInfo.mockResolvedValue(info({
      git: { branch: "b", ahead: 0, behind: 0, staged: 2, modified: 3, untracked: 1 },
    }))
    wrap(summary())
    expect(await screen.findByText(/2 staged · 3 modified · 1 untracked/)).toBeInTheDocument()
  })

  it("reports ahead/behind even when the tree is clean", async () => {
    // A branch with unpushed commits is not the same as one in sync, so
    // "clean" alone would hide something worth seeing.
    worktreeInfo.mockResolvedValue(info({
      git: { branch: "b", ahead: 2, behind: 1, staged: 0, modified: 0, untracked: 0 },
    }))
    wrap(summary())
    expect(await screen.findByText(/clean · ahead 2 · behind 1/)).toBeInTheDocument()
  })

  it("still renders the header when the info request fails", async () => {
    // A worktree missing from disk, or git unavailable, must not blank the card.
    worktreeInfo.mockRejectedValue(new Error("boom"))
    wrap(summary())
    await waitFor(() => expect(screen.getByText("foo")).toBeInTheDocument())
    expect(screen.getByText(/my-branch/)).toBeInTheDocument()
  })
})

describe("delete control", () => {
  it("opens the delete modal from the trash control", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("button", { name: /delete worktree/i }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    // The typed-name confirmation is the safeguard; it must be present.
    expect(screen.getByLabelText(/type the worktree name/i)).toBeInTheDocument()
  })

  it("does not delete anything just by opening the modal", async () => {
    worktreeInfo.mockResolvedValue(info())
    const user = userEvent.setup()
    wrap(summary())
    await user.click(await screen.findByRole("button", { name: /delete worktree/i }))
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeDisabled()
  })
})
