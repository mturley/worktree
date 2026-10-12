import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { JiraPriorityIcon } from "./JiraPriorityIcon"

const jira = (over: Partial<ResourceDTO>): ResourceDTO =>
  ({ type: "jira", id: "X-1", url: "u", primary: true, ...over }) as ResourceDTO

const renderIcon = (r: ResourceDTO) =>
  render(<MantineProvider><JiraPriorityIcon r={r} /></MantineProvider>)

afterEach(cleanup)

describe("JiraPriorityIcon", () => {
  const iconURL = "https://acme.atlassian.net/images/icons/priorities/major.svg"

  it("shows Jira's own priority icon through the proxy instead of a badge", () => {
    renderIcon(jira({ priority: "Major", priority_icon_url: iconURL }))
    const img = screen.getByRole("img", { name: "Priority: Major" })
    expect(img.getAttribute("src")).toBe("/api/jira-icon?url=" + encodeURIComponent(iconURL))
    expect(screen.queryByText("Major")).toBeNull()
  })

  it("names the priority in a tooltip", async () => {
    renderIcon(jira({ priority: "Major", priority_icon_url: iconURL }))
    await userEvent.hover(screen.getByRole("img", { name: "Priority: Major" }))
    expect(await screen.findByText("Priority: Major")).toBeInTheDocument()
  })

  it("falls back to the text badge when no icon URL is cached", () => {
    renderIcon(jira({ priority: "Major" }))
    expect(screen.getByText("Major")).toBeInTheDocument()
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("falls back to the text badge when the icon fails to load", () => {
    renderIcon(jira({ priority: "Major", priority_icon_url: iconURL }))
    fireEvent.error(screen.getByRole("img", { name: "Priority: Major" }))
    expect(screen.getByText("Major")).toBeInTheDocument()
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("renders nothing without a priority", () => {
    const { container } = renderIcon(jira({ priority_icon_url: iconURL }))
    expect(container.querySelector("img")).toBeNull()
  })
})
