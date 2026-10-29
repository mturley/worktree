import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { api } from "../../../api/client"
import type { TaskDetailLink } from "../../../api/types"
import { LinksSection } from "./LinksSection"
import { detail, renderDetail, stubRowLayout } from "./detailsTestUtils"

vi.mock("../../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../../api/client")>()),
  api: {
    taskDetail: vi.fn(),
    worktrees: vi.fn(),
    worktreeResources: vi.fn(),
    allResources: vi.fn(),
    addTaskLink: vi.fn(),
    removeTaskLink: vi.fn(),
    setTaskLinkFocus: vi.fn(),
    orderTaskLinks: vi.fn(),
  },
}))

const pr: TaskDetailLink = {
  kind: "resource", resource_type: "pr", resource_id: "o/r#1", focus: true, archived: false,
  title: "Fix login", url: "https://github.com/o/r/pull/1",
}
const jira: TaskDetailLink = {
  kind: "resource", resource_type: "jira", resource_id: "RHOAIENG-1", focus: false, archived: false,
  title: "Login epic", url: "https://redhat.atlassian.net/browse/RHOAIENG-1",
}
const wt: TaskDetailLink = { kind: "worktree", worktree: "/w/feat", focus: false, archived: false, title: "feat" }

const base = detail({
  detail_links: [pr, jira, wt],
  links: [pr, jira, wt],
  implicit: [{ worktree: "/w/impl", branch: "impl-branch", via: ["pr:o/r#4521", "jira:RHOAIENG-1"] }],
  implicit_worktrees: ["/w/impl"],
})

beforeEach(() => {
  vi.mocked(api.taskDetail).mockResolvedValue(base)
  vi.mocked(api.worktrees).mockResolvedValue([])
  vi.mocked(api.worktreeResources).mockResolvedValue([])
  for (const fn of [api.addTaskLink, api.removeTaskLink, api.setTaskLinkFocus, api.orderTaskLinks]) {
    vi.mocked(fn).mockResolvedValue(base)
  }
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const show = () => renderDetail(base, (d) => <LinksSection task={d} />)

describe("LinksSection", () => {
  it("groups links into Focus and Related, resource titles opening in a new tab", () => {
    show()
    const focus = screen.getByTestId("links-focus")
    const related = screen.getByTestId("links-related")
    expect(within(focus).getByText("Fix login")).toBeInTheDocument()
    expect(within(related).getByText("Login epic")).toBeInTheDocument()
    expect(within(related).getByText("⎇ feat")).toBeInTheDocument()
    const a = screen.getByRole("link", { name: /Fix login/ })
    expect(a).toHaveAttribute("href", pr.url)
    expect(a).toHaveAttribute("target", "_blank")
  })

  it("removes a link without asking", async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole("button", { name: "Remove link: Login epic" }))
    expect(api.removeTaskLink).toHaveBeenCalledWith(1, { kind: "resource", type: "jira", rid: "RHOAIENG-1" })
    await user.click(screen.getByRole("button", { name: "Remove link: feat" }))
    expect(api.removeTaskLink).toHaveBeenCalledWith(1, { kind: "worktree", path: "/w/feat" })
  })

  it("the grip's hover menu moves a link to the other group", async () => {
    const user = userEvent.setup()
    show()
    await user.hover(screen.getByRole("button", { name: "Drag to reorder Fix login" }))
    await user.click(await screen.findByRole("button", { name: "Make Related" }))
    expect(api.setTaskLinkFocus).toHaveBeenCalledWith(1, { kind: "resource", type: "pr", rid: "o/r#1" }, false)
  })

  it("implicit worktrees are dashed, read-only and say what they follow", () => {
    show()
    const row = screen.getByTestId("implicit-/w/impl")
    expect(row).toHaveTextContent("impl-branch")
    expect(row).toHaveTextContent("via #4521, RHOAIENG-1")
    expect(row.style.borderStyle).toBe("dashed")
    expect(within(row).queryByRole("button")).toBeNull()
  })

  it("names worktrees by their cmux workspace, and previews links on hover", async () => {
    const { qc } = show()
    act(() => {
      qc.setQueryData(["cmux"], {
        available: true,
        matches: {
          "/w/feat": [{ ref: "workspace:1", title: "Feature work", color: "#00ff00", selected: false }],
          "/w/impl": [{ ref: "workspace:2", title: "Implicit work", selected: false }],
        },
      })
      qc.setQueryData(["session"], { handle: "h", label: "", created_at: "", last_seen_at: "", current: true, home: "/w" })
      qc.setQueryData(["resources", "__all__"], [{
        type: "pr", id: "o/r#1", url: "https://github.com/o/r/pull/1", primary: true, title: "Fix login",
        worktrees: [{ path: "/w/feat", repo: "r", branch: "login-branch" }],
      }])
    })
    const feature = await screen.findByText("Feature work")
    expect(screen.getByText("⎇ feat")).toBeInTheDocument()
    expect(within(screen.getByTestId("implicit-/w/impl")).getByText("Implicit work")).toBeInTheDocument()

    await userEvent.hover(feature)
    // The path with ~ for the server's home directory.
    expect(await screen.findByText("~/feat")).toBeInTheDocument()
    await userEvent.unhover(feature)

    // The resource's preview names its worktree by the workspace too.
    const named = screen.getAllByText("Feature work").length
    await userEvent.hover(screen.getByRole("link", { name: "Fix login" }))
    await waitFor(() => expect(screen.getAllByText("Feature work")).toHaveLength(named + 1))
  })

  describe("drag", () => {
    beforeEach(() => {
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        stubRowLayout("[data-link-sortable]", "[data-link-drop]"),
      )
    })
    afterEach(() => vi.mocked(Element.prototype.getBoundingClientRect).mockRestore())

    const lift = async (name: string, key: "ArrowDown" | "ArrowUp") => {
      const grip = screen.getByRole("button", { name: `Drag to reorder ${name}` })
      act(() => grip.focus())
      fireEvent.keyDown(grip, { code: "Space", key: " " })
      // Picked up once dnd-kit has measured the rows, which takes a render.
      await waitFor(() => expect(grip).toHaveAttribute("aria-pressed", "true"))
      fireEvent.keyDown(grip, { code: key, key })
      fireEvent.keyDown(grip, { code: "Space", key: " " })
    }

    it("a drop into the other group sends both groups in full", async () => {
      show()
      await lift("Fix login", "ArrowDown")
      await waitFor(() => expect(api.orderTaskLinks).toHaveBeenCalled())
      expect(api.orderTaskLinks).toHaveBeenCalledWith(
        1,
        [],
        [
          { kind: "resource", type: "pr", rid: "o/r#1" },
          { kind: "resource", type: "jira", rid: "RHOAIENG-1" },
          { kind: "worktree", path: "/w/feat" },
        ],
      )
    })

    it("a reorder within a group also sends both groups", async () => {
      show()
      await lift("feat", "ArrowUp")
      await waitFor(() => expect(api.orderTaskLinks).toHaveBeenCalled())
      expect(api.orderTaskLinks).toHaveBeenCalledWith(
        1,
        [{ kind: "resource", type: "pr", rid: "o/r#1" }],
        [{ kind: "worktree", path: "/w/feat" }, { kind: "resource", type: "jira", rid: "RHOAIENG-1" }],
      )
    })
  })
})
