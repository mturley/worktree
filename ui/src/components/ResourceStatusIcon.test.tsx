import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { ResourceStatusIcon, ResourceTitle, resourceStatusMeta } from "./ResourceStatusIcon"

const base = (over: Partial<ResourceDTO>): ResourceDTO =>
  ({ type: "pr", id: "o/r#1", url: "u", primary: true, ...over }) as ResourceDTO

afterEach(cleanup)

describe("resourceStatusMeta", () => {
  it("colors PRs by state like GitHub", () => {
    expect(resourceStatusMeta(base({ state: "OPEN" })).color).toBe("green")
    expect(resourceStatusMeta(base({ state: "MERGED" })).color).toBe("violet")
    expect(resourceStatusMeta(base({ state: "CLOSED" })).color).toBe("red")
  })

  it("colors Jira by status family", () => {
    expect(resourceStatusMeta(base({ type: "jira", status: "Done" })).color).toBe("green")
    expect(resourceStatusMeta(base({ type: "jira", status: "In Progress" })).color).toBe("blue")
    expect(resourceStatusMeta(base({ type: "jira", status: "Backlog" })).color).toBe("gray")
  })

  it("uses grape for slack and gray for never-polled resources", () => {
    expect(resourceStatusMeta(base({ type: "slack" })).color).toBe("grape")
    expect(resourceStatusMeta(base({ state: undefined })).color).toBe("gray")
  })
})

describe("ResourceStatusIcon", () => {
  it("exposes the status as an accessible label", () => {
    render(<ResourceStatusIcon r={base({ state: "MERGED" })} />)
    expect(screen.getByLabelText("merged")).toBeInTheDocument()
  })
})

describe("Jira issue-type icons", () => {
  const bug = base({
    type: "jira",
    status: "In Progress",
    issue_type: "Bug",
    issue_type_icon_url: "https://acme.atlassian.net/rest/api/2/universal_avatar/x/10303",
  })

  it("renders the icon Jira serves, through the auth-attaching proxy", () => {
    render(<ResourceStatusIcon r={bug} />)
    const img = screen.getByRole("img", { name: "Bug — In Progress" })
    expect(img.getAttribute("src")).toBe(
      "/api/jira-icon?url=" +
        encodeURIComponent("https://acme.atlassian.net/rest/api/2/universal_avatar/x/10303"),
    )
  })

  it("falls back to the bundled icon when the fetch fails", () => {
    render(<ResourceStatusIcon r={bug} />)
    fireEvent.error(screen.getByRole("img", { name: "Bug — In Progress" }))
    // The tabler fallback labels itself with the status, and is not an <img>.
    const fallback = screen.getByLabelText("In Progress")
    expect(fallback.tagName.toLowerCase()).not.toBe("img")
  })

  it("uses the bundled icon when no icon URL was cached", () => {
    render(<ResourceStatusIcon r={base({ type: "jira", status: "Backlog" })} />)
    expect(screen.getByLabelText("Backlog").tagName.toLowerCase()).not.toBe("img")
  })
})

describe("ResourceTitle", () => {
  it("pairs the status icon with the title", () => {
    render(<MantineProvider><ResourceTitle r={base({ state: "OPEN", title: "Fix the widget" })} /></MantineProvider>)
    expect(screen.getByText("Fix the widget")).toBeInTheDocument()
    // Same icon mapping as the worktree card's focus lines, so changing an
    // icon in resourceStatusMeta changes both surfaces at once.
    expect(screen.getByLabelText("open")).toBeInTheDocument()
  })

  it("accepts an explicit label, for resources whose display name differs", () => {
    render(<MantineProvider><ResourceTitle r={base({ type: "slack" })} label="Deploy thread" /></MantineProvider>)
    expect(screen.getByText("Deploy thread")).toBeInTheDocument()
    expect(screen.getByLabelText("slack thread")).toBeInTheDocument()
  })
})
