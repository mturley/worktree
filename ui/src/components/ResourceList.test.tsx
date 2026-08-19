import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { ResourceList } from "./ResourceList"

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const addResource = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api, addResource: (...args: unknown[]) => addResource(...args) } }
})

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

afterEach(() => {
  cleanup()
  addResource.mockReset()
})

describe("ResourceList add-resource field", () => {
  it("calls api.addResource with {path, url} and triggers onChanged on success", async () => {
    addResource.mockResolvedValueOnce({ type: "pr", id: "org/repo#1", url: "https://github.com/org/repo/pull/1", primary: false })
    const onChanged = vi.fn()
    const user = userEvent.setup()
    const { getByPlaceholderText, getByRole } = wrap(
      <ResourceList items={[]} path="/some/worktree" onChanged={onChanged} />,
    )

    const input = getByPlaceholderText("Paste a PR, Jira, or Slack URL")
    await user.type(input, "https://github.com/org/repo/pull/1")
    await user.click(getByRole("button", { name: "Add" }))

    expect(addResource).toHaveBeenCalledWith({ path: "/some/worktree", url: "https://github.com/org/repo/pull/1" })
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect((input as HTMLInputElement).value).toBe("")
  })

  it("shows a dismissible error alert when addResource rejects", async () => {
    addResource.mockRejectedValueOnce(new Error("could not parse url"))
    const onChanged = vi.fn()
    const user = userEvent.setup()
    const { getByPlaceholderText, getByRole, findByText } = wrap(
      <ResourceList items={[]} path="/some/worktree" onChanged={onChanged} />,
    )

    const input = getByPlaceholderText("Paste a PR, Jira, or Slack URL")
    await user.type(input, "not-a-url")
    await user.click(getByRole("button", { name: "Add" }))

    expect(await findByText("could not parse url")).toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("disables the Add button while the field is empty", () => {
    const { getByRole } = wrap(<ResourceList items={[]} path="/some/worktree" onChanged={vi.fn()} />)
    expect(getByRole("button", { name: "Add" })).toBeDisabled()
  })
})
