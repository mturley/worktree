import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { SourceFilter } from "./SourceFilter"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(cleanup)

describe("SourceFilter", () => {
  it("offers one toggle per source, named for the service", () => {
    wrap(<SourceFilter value={[]} onChange={vi.fn()} />)
    for (const name of ["GitHub", "Jira", "Slack"]) {
      expect(screen.getByRole("button", { name: new RegExp(name, "i") })).toBeInTheDocument()
    }
  })

  it("adds a source on click and reports it as pressed", () => {
    const onChange = vi.fn()
    wrap(<SourceFilter value={[]} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: /github/i }))
    // "pr" is the resource type behind the "GitHub" label.
    expect(onChange).toHaveBeenCalledWith(["pr"])
  })

  it("replaces the selection rather than adding to it", () => {
    // Single-select: picking Jira drops GitHub.
    const onChange = vi.fn()
    wrap(<SourceFilter value={["pr"]} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: /jira/i }))
    expect(onChange).toHaveBeenCalledWith(["jira"])
  })

  it("clears back to everything when the active source is clicked again", () => {
    // The only way back to an unfiltered feed, so it has to work.
    const onChange = vi.fn()
    wrap(<SourceFilter value={["jira"]} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: /jira/i }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("marks selected sources with aria-pressed", () => {
    wrap(<SourceFilter value={["slack"]} onChange={vi.fn()} />)
    expect(screen.getByRole("button", { name: /slack/i })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: /jira/i })).toHaveAttribute("aria-pressed", "false")
  })
})

describe("SourceFilter branding", () => {
  it("uses each source's official mark, with its colour in the artwork", () => {
    const { container } = wrap(<SourceFilter value={[]} onChange={vi.fn()} />)
    const svgs = [...container.querySelectorAll("svg")]
    expect(svgs).toHaveLength(3)

    // Slack: its own four-colour mark, colours baked into the fills.
    const slackFills = [...svgs[2].querySelectorAll("path")].map((p) => p.getAttribute("fill"))
    expect(slackFills).toContain("#36C5F0")

    // Jira: Atlassian's own mark — the brand blue is baked into the artwork.
    const jiraFills = [...svgs[1].querySelectorAll("path")].map((p) => p.getAttribute("fill"))
    expect(jiraFills).toContain("#1868DB")

    // GitHub: the Invertocat is monochrome by design, and white is the
    // variant GitHub ships for dark backgrounds — so the colour is part of
    // the artwork, not applied from outside.
    const ghFills = [...svgs[0].querySelectorAll("path")].map((p) => p.getAttribute("fill"))
    expect(ghFills).toContain("white")
  })
})

