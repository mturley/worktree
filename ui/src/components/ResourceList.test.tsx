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

describe("ResourceList", () => {
  it("opens the add-resource modal from the Add resource button", async () => {
    const user = userEvent.setup()
    const { getByRole, queryByLabelText, findByLabelText } = wrap(
      <ResourceList items={[]} path="/some/worktree" onChanged={vi.fn()} />,
    )

    expect(queryByLabelText(/url/i)).not.toBeInTheDocument()
    await user.click(getByRole("button", { name: /add resource/i }))
    expect(await findByLabelText(/url/i)).toBeInTheDocument()
  })

  it("adds a resource through the modal and refetches on success", async () => {
    addResource.mockResolvedValueOnce({ type: "pr", id: "org/repo#1", url: "u", primary: true })
    const onChanged = vi.fn()
    const user = userEvent.setup()
    const { getByRole, findByLabelText } = wrap(
      <ResourceList items={[]} path="/some/worktree" onChanged={onChanged} />,
    )

    await user.click(getByRole("button", { name: /add resource/i }))
    await user.type(await findByLabelText(/url/i), "https://github.com/org/repo/pull/1")
    await user.click(getByRole("button", { name: "Add" }))

    expect(addResource).toHaveBeenCalledWith({
      path: "/some/worktree",
      url: "https://github.com/org/repo/pull/1",
      related: false,
    })
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it("renders Focus and Related sections", () => {
    const items = [
      { type: "pr", id: "a", url: "u", primary: true },
      { type: "jira", id: "b", url: "u", primary: false },
    ]
    const { getByText } = wrap(<ResourceList items={items} path="/wt" onChanged={vi.fn()} />)
    expect(getByText("Focus")).toBeInTheDocument()
    expect(getByText("Related")).toBeInTheDocument()
  })
})

describe("Add resource placement", () => {
  it("sits after the resource cards, so the list starts at the top", () => {
    const items = [{ type: "pr", id: "a", url: "u", primary: true, title: "Fix the widget" }]
    const { getByRole, getByText } = wrap(
      <ResourceList items={items} path="/wt" onChanged={vi.fn()} />,
    )
    const add = getByRole("button", { name: /add resource/i })
    const firstCard = getByText("Fix the widget")
    // DOCUMENT_POSITION_PRECEDING (2) means the card comes before the button.
    expect(add.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })
})

