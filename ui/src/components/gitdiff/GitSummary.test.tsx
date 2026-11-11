import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { api } from "../../api/client"
import type { ResourceDTO, WorktreeGit } from "../../api/types"
import { DirectoryRow, GitSummary } from "./GitSummary"

vi.mock("../../api/client", async (orig) => ({
  ...(await orig<typeof import("../../api/client")>()),
  api: { worktreeResources: vi.fn(), allResources: vi.fn() },
}))

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
      <GitSummary path="/wt/foo" git={{ ...base, ...over }} repo="r" />
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
        <GitSummary path="/wt/foo" git={base} repo="r" oneColumn />
      </MantineProvider>,
    )
    const columns = container.querySelector<HTMLElement>("[style*='flex-direction']")
    expect(columns?.style.flexDirection).toBe("column")
  })

  it("lines every label up at one width, with the shorter Tracking label", () => {
    render(
      <MantineProvider>
        <GitSummary path="/wt/foo" git={base} repo="r" oneColumn />
      </MantineProvider>,
    )
    expect(screen.getByText("Tracking")).toBeInTheDocument()
    expect(screen.queryByText("Tracking branch")).toBeNull()
    const widths = ["Repo", "Branch", "Working tree", "Merge base", "Tracking", "Fetched"].map(
      (l) => screen.getByText(l).style.minWidth,
    )
    expect(new Set(widths)).toEqual(new Set([widths[0]]))
    expect(widths[0]).not.toBe("")
  })

  it("keeps Tracking branch in two columns", () => {
    show()
    expect(screen.getByText("Tracking branch")).toBeInTheDocument()
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

describe("GitSummary ahead/behind lines", () => {
  it("shows a non-zero behind in orange, against either ref", () => {
    show({ vs_merge_base: { ahead: 4, behind: 2 }, vs_tracking: { ahead: 0, behind: 5 } })
    expect(screen.getByText("2 behind").getAttribute("style")).toContain("orange")
    expect(screen.getByText("5 behind").getAttribute("style")).toContain("orange")
  })

  it("leaves a zero behind dimmed", () => {
    show()
    const zeros = screen.getAllByText("0 behind")
    expect(zeros).toHaveLength(2)
    for (const el of zeros) {
      expect(el.getAttribute("style") ?? "").not.toContain("orange")
    }
  })

  it("keeps the line's text intact", () => {
    show({ vs_merge_base: { ahead: 4, behind: 2 } })
    expect(screen.getByText("2 behind").parentElement?.textContent).toBe("(4 ahead · 2 behind)")
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

describe("GitSummary PR row", () => {
  const prResource: ResourceDTO = {
    type: "pr", id: "o/r#7", url: "https://github.com/o/r/pull/7", primary: true, title: "Add linting",
  }
  const showPR = (opts: { over?: Partial<WorktreeGit>; oneColumn?: boolean; onOpenPR?: () => void; resources?: ResourceDTO[] } = {}) => {
    vi.mocked(api.worktreeResources).mockResolvedValue(opts.resources ?? [prResource])
    vi.mocked(api.allResources).mockResolvedValue([])
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <MantineProvider>
          <GitSummary
            path="/wt/foo"
            git={{ ...base, pr: "o/r#7", ...opts.over }}
            repo="r"
            oneColumn={opts.oneColumn}
            onOpenPR={opts.onOpenPR}
          />
        </MantineProvider>
      </QueryClientProvider>,
    )
  }

  it("shows a PR row between Branch and Working tree, with the number and title", async () => {
    showPR()
    expect(await screen.findByText("Add linting")).toBeInTheDocument()
    const label = screen.getByText("PR")
    const row = label.parentElement as HTMLElement
    expect(within(row).getByText("#7")).toBeInTheDocument()
    expect(screen.getByText("Branch").parentElement?.nextElementSibling).toBe(row)
    expect(row.nextElementSibling).toBe(screen.getByText("Working tree").parentElement)
  })

  it("has no PR row without a tracked PR", () => {
    showPR({ over: { pr: undefined } })
    expect(screen.queryByText("PR")).toBeNull()
  })

  it("shows just the number while the resource is not loaded", async () => {
    showPR({ resources: [] })
    expect(await screen.findByText("#7")).toBeInTheDocument()
    expect(vi.mocked(api.worktreeResources)).toHaveBeenCalled()
    expect(screen.queryByText("Add linting")).toBeNull()
  })

  it("calls onOpenPR with the PR's key when #N is clicked", async () => {
    const onOpenPR = vi.fn()
    showPR({ onOpenPR })
    await userEvent.click(await screen.findByText("#7"))
    expect(onOpenPR).toHaveBeenCalledWith({ type: "pr", id: "o/r#7" })
  })

  it("still renders in one column", async () => {
    showPR({ oneColumn: true })
    expect(await screen.findByText("Add linting")).toBeInTheDocument()
    expect(screen.getByText("PR")).toBeInTheDocument()
  })
})
