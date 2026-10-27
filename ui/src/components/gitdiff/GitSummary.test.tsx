import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { WorktreeGit } from "../../api/types"
import { DirectoryRow, GitSummary } from "./GitSummary"

const base: WorktreeGit = {
  on_disk: true, fingerprint: "f", working_fingerprint: "wf", branch: "my-branch",
  main_upstream: "upstream/main", merge_base: "76ef50c1234567890abcdef1234567890abcdef12",
  vs_merge_base: { ahead: 4, behind: 0 },
  tracking: "origin/my-branch", vs_tracking: { ahead: 0, behind: 0 },
  working: { staged: 0, modified: 0, untracked: 0, files: 0 },
  fetch: { in_progress: false },
}

const show = (over: Partial<WorktreeGit> = {}) =>
  render(
    <MantineProvider>
      <GitSummary git={{ ...base, ...over }} repo="r" />
    </MantineProvider>,
  )

const showDir = (over: Partial<WorktreeGit> = {}) =>
  render(
    <MantineProvider>
      <DirectoryRow path="/wt/foo" git={{ ...base, ...over }} />
    </MantineProvider>,
  )

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("GitSummary oneColumn", () => {
  it("stacks the columns even when wide", () => {
    const { container } = render(
      <MantineProvider>
        <GitSummary git={base} repo="r" oneColumn />
      </MantineProvider>,
    )
    const columns = container.querySelector<HTMLElement>("[style*='flex-direction']")
    expect(columns?.style.flexDirection).toBe("column")
  })
})

describe("GitSummary working tree line", () => {
  it("is just 'clean' when everything is committed and pushed", () => {
    show()
    expect(screen.getByTestId("working-tree").textContent).toBe("clean")
  })

  it("appends unpushed commits to a clean tree, in the badge's orange", () => {
    show({ vs_tracking: { ahead: 3, behind: 0 } })
    expect(screen.getByTestId("working-tree").textContent).toBe("clean (3 unpushed commits)")
    expect(screen.getByText("(3 unpushed commits)").getAttribute("style")).toContain("orange")
  })

  it("appends them after the dirty summary, which stays yellow", () => {
    show({
      tracking: undefined,
      vs_tracking: undefined,
      vs_merge_base: { ahead: 1, behind: 0 },
      working: { staged: 0, modified: 2, untracked: 1, files: 3 },
    })
    expect(screen.getByTestId("working-tree").textContent).toBe("2 modified · 1 untracked (1 unpushed commit)")
    expect(screen.getByText("2 modified · 1 untracked").getAttribute("style")).toContain("yellow")
    expect(screen.getByText("(1 unpushed commit)").getAttribute("style") ?? "").not.toContain("orange")
  })
})

describe("GitSummary labels", () => {
  it("never wrap", () => {
    show()
    for (const label of ["Working tree", "Merge base", "Tracking branch"]) {
      expect(screen.getByText(label).style.whiteSpace).toBe("nowrap")
    }
  })
})

describe("DirectoryRow", () => {
  it("shows the working directory and a button that copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    showDir()
    expect(screen.getByText("/wt/foo")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Copy directory path" }))
    expect(writeText).toHaveBeenCalledWith("/wt/foo")
  })

  it("shows the server's ~ form of the path, and copies it as shown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    showDir({ directory: "~/wt/foo" })
    expect(screen.getByText("~/wt/foo")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Copy directory path" }))
    expect(writeText).toHaveBeenCalledWith("~/wt/foo")
  })

  it("is left out of the Code tab's summary", () => {
    show()
    expect(screen.queryByText("Directory")).toBeNull()
  })
})

describe("GitSummary branch", () => {
  it("has a button that copies the branch name", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    show()
    await userEvent.click(screen.getByRole("button", { name: "Copy branch name" }))
    expect(writeText).toHaveBeenCalledWith("my-branch")
  })
})
