import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { ResourceActions, openInLabel } from "./ResourceActions"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
const res = (over: Partial<ResourceDTO>): ResourceDTO =>
  ({ type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, ...over }) as ResourceDTO

afterEach(cleanup)

describe("openInLabel", () => {
  it("names the destination per resource type", () => {
    expect(openInLabel("pr")).toBe("Open in GitHub")
    expect(openInLabel("jira")).toBe("Open in Jira")
    expect(openInLabel("slack")).toBe("Open in Slack")
  })

  it("falls back to a generic label for an unknown type", () => {
    expect(openInLabel("weird")).toBe("Open")
  })
})

describe("ResourceActions", () => {
  it("links to the resource url", () => {
    wrap(<ResourceActions r={res({})} />)
    expect(screen.getByRole("link", { name: "Open in GitHub" })).toHaveAttribute("href", "https://gh/pr/1")
  })

  it("copies the url and shows feedback", async () => {
    // userEvent.setup() installs its own clipboard stub, so ours must be
    // applied AFTER it or it gets clobbered.
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    wrap(<ResourceActions r={res({})} />)
    await user.click(screen.getByRole("button", { name: /copy link/i }))
    expect(writeText).toHaveBeenCalledWith("https://gh/pr/1")
    expect(await screen.findByLabelText("Copy link")).toBeInTheDocument()
  })

  it("renders nothing when the resource has no url", () => {
    // MantineProvider injects a <style> element, so assert on the controls
    // rather than on the container being textually empty.
    wrap(<ResourceActions r={res({ url: "" })} />)
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /copy link/i })).not.toBeInTheDocument()
  })
})
