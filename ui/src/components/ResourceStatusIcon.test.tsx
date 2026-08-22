import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import type { ResourceDTO } from "../api/types"
import { ResourceStatusIcon, resourceStatusMeta } from "./ResourceStatusIcon"

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
