import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { api } from "../../../api/client"
import type { AllResourceDTO, ResourceDTO, TaskDetailLink, WorktreeSummary } from "../../../api/types"
import { LinkPicker } from "./LinkPicker"
import { detail, renderDetail } from "./detailsTestUtils"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: {
    taskDetail: vi.fn(),
    worktrees: vi.fn(),
    worktreeResources: vi.fn(),
    allResources: vi.fn(),
    addTaskLink: vi.fn(),
  },
}))

const linkedPr: TaskDetailLink = {
  kind: "resource", resource_type: "pr", resource_id: "o/r#1", focus: true, archived: false, title: "Fix login",
}
const linkedWt: TaskDetailLink = { kind: "worktree", worktree: "/w/feat", focus: false, archived: false, title: "feat" }

const res = (id: string, title: string): ResourceDTO => ({ type: "pr", id, url: `https://x/${id}`, primary: false, title })
const wts = [
  { path: "/w/feat", repo: "r", branch: "feat" },
  { path: "/w/other", repo: "r", branch: "other-branch" },
] as WorktreeSummary[]

const withWorktree = detail({
  detail_links: [linkedPr, linkedWt],
  links: [linkedPr, linkedWt],
  implicit: [{ worktree: "/w/impl", branch: "impl", via: ["pr:o/r#1"] }],
  implicit_worktrees: ["/w/impl"],
})

// Selecting an option scrolls it into view; jsdom has no scrollIntoView.
const originalScroll = Element.prototype.scrollIntoView
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  Element.prototype.scrollIntoView = originalScroll
})

beforeEach(() => {
  vi.mocked(api.taskDetail).mockResolvedValue(withWorktree)
  vi.mocked(api.worktrees).mockResolvedValue(wts)
  vi.mocked(api.worktreeResources).mockImplementation(async (path: string) =>
    path === "/w/feat" ? [res("o/r#1", "Fix login"), res("o/r#2", "Fix logout")] : [res("o/r#3", "Impl thing")],
  )
  vi.mocked(api.allResources).mockResolvedValue([
    { ...res("o/r#9", "Global thing"), worktrees: [{ path: "/w/other", repo: "r", branch: "other-branch" }] },
  ] as AllResourceDTO[])
  vi.mocked(api.addTaskLink).mockResolvedValue(withWorktree)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openPicker(t = withWorktree) {
  const user = userEvent.setup()
  renderDetail(t, (d) => <LinkPicker task={d} />)
  await user.click(screen.getByRole("button", { name: "+ Link resource or worktree" }))
  return { user, input: screen.getByRole("textbox", { name: "Link resource or worktree" }) }
}

describe("LinkPicker", () => {
  it("suggests the task's worktrees' resources and every worktree, minus what is linked", async () => {
    const { user, input } = await openPicker()
    await user.click(input)
    expect(await screen.findByRole("option", { name: /Fix logout/ })).toBeInTheDocument()
    expect(await screen.findByRole("option", { name: /Impl thing/ })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /other-branch/ })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Fix login/ })).toBeNull()
    expect(screen.queryByRole("option", { name: /^⎇ feat/ })).toBeNull()
    expect(api.worktreeResources).toHaveBeenCalledWith("/w/feat")
    expect(api.worktreeResources).toHaveBeenCalledWith("/w/impl")
    expect(api.allResources).not.toHaveBeenCalled()
  })

  it("a chosen suggestion is linked as Related", async () => {
    const { user, input } = await openPicker()
    await user.type(input, "logout")
    await user.click(await screen.findByRole("option", { name: /Fix logout/ }))
    expect(api.addTaskLink).toHaveBeenCalledWith(1, { kind: "resource", type: "pr", rid: "o/r#2" }, false)
  })

  it("a chosen worktree is linked as Related", async () => {
    const { user, input } = await openPicker()
    await user.type(input, "other")
    await user.click(await screen.findByRole("option", { name: /other-branch/ }))
    expect(api.addTaskLink).toHaveBeenCalledWith(1, { kind: "worktree", path: "/w/other" }, false)
  })

  it("typing preselects the first match, so Enter links it", async () => {
    const { user, input } = await openPicker()
    await user.type(input, "logout")
    const option = await screen.findByRole("option", { name: /Fix logout/ })
    await waitFor(() => expect(option).toHaveAttribute("data-combobox-selected"))
    await user.keyboard("{Enter}")
    await waitFor(() =>
      expect(api.addTaskLink).toHaveBeenCalledWith(1, { kind: "resource", type: "pr", rid: "o/r#2" }, false),
    )
    expect(api.addTaskLink).toHaveBeenCalledTimes(1)
  })

  it("a pasted URL is linked by URL on Enter", async () => {
    const { user, input } = await openPicker()
    await user.click(input)
    await user.paste("https://github.com/o/r/pull/77")
    await user.keyboard("{Enter}")
    await waitFor(() =>
      expect(api.addTaskLink).toHaveBeenCalledWith(1, { url: "https://github.com/o/r/pull/77" }, false),
    )
    // Once: the preselected "Link <url>" option and the Enter fallback are one path.
    expect(api.addTaskLink).toHaveBeenCalledTimes(1)
  })

  it("a task with no worktrees suggests from all resources", async () => {
    const { user, input } = await openPicker(detail())
    await user.click(input)
    expect(await screen.findByRole("option", { name: /Global thing/ })).toBeInTheDocument()
    expect(api.worktreeResources).not.toHaveBeenCalled()
  })

  it("a failed add says why", async () => {
    vi.mocked(api.addTaskLink).mockRejectedValue(new Error("unrecognised URL"))
    const { user, input } = await openPicker()
    await user.click(input)
    await user.paste("https://example.com/nope")
    await user.keyboard("{Enter}")
    expect(await screen.findByText(/unrecognised URL/)).toBeInTheDocument()
  })
})
