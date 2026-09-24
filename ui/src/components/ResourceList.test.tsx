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
    await user.click(getByRole("button", { name: /follow resource/i }))
    expect(await findByLabelText(/url/i)).toBeInTheDocument()
  })

  it("adds a resource through the modal and refetches on success", async () => {
    addResource.mockResolvedValueOnce({ type: "pr", id: "org/repo#1", url: "u", primary: true })
    const onChanged = vi.fn()
    const user = userEvent.setup()
    const { getByRole, findByLabelText } = wrap(
      <ResourceList items={[]} path="/some/worktree" onChanged={onChanged} />,
    )

    await user.click(getByRole("button", { name: /follow resource/i }))
    await user.type(await findByLabelText(/url/i), "https://github.com/org/repo/pull/1")
    await user.click(getByRole("button", { name: "Follow" }))

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
  it("heads the list, as a toolbar for the cards it acts on", () => {
    const items = [{ type: "pr", id: "a", url: "u", primary: true, title: "Fix the widget" }]
    const { getByRole, getByText } = wrap(
      <ResourceList items={items} path="/wt" onChanged={vi.fn()} />,
    )
    const add = getByRole("button", { name: /follow resource/i })
    const firstCard = getByText("Fix the widget")
    // DOCUMENT_POSITION_FOLLOWING (4) means the card comes after the button.
    expect(add.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("puts the Focus heading below the toolbar too", () => {
    const items = [{ type: "pr", id: "a", url: "u", primary: true, title: "Fix the widget" }]
    const { getByRole, getByText } = wrap(
      <ResourceList items={items} path="/wt" onChanged={vi.fn()} />,
    )
    const add = getByRole("button", { name: /follow resource/i })
    expect(add.compareDocumentPosition(getByText("Focus")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})


describe("Add resource emphasis", () => {
  it("is drawn filled, as the primary action of the column", () => {
    // It is the only thing on this column you can DO; a light variant read
    // as secondary beside the resource cards it heads.
    const { getByRole } = wrap(<ResourceList items={[]} path="/wt" onChanged={vi.fn()} />)
    expect(getByRole("button", { name: /follow resource/i })).toHaveAttribute("data-variant", "filled")
  })
})

describe("ResourceList reorder mode", () => {
  const items = [
    { type: "pr", id: "o/r#1", url: "u", primary: true },
    { type: "jira", id: "RH-9", url: "u", primary: false },
  ]

  it("shows no drag handles until reorder mode is entered", () => {
    const { queryAllByLabelText } = wrap(
      <ResourceList items={items} path="/w" onChanged={vi.fn()} />,
    )
    expect(queryAllByLabelText(/drag to reorder/i)).toHaveLength(0)
  })

  it("labels the reorder control for screen readers even though it shows only an icon", () => {
    const { getByRole } = wrap(<ResourceList items={items} path="/w" onChanged={vi.fn()} />)
    const button = getByRole("button", { name: /reorder resources/i })
    // The word itself must not be the label: it is an icon button now, and a
    // visible "Reorder" would mean the text was never actually replaced.
    expect(button.textContent).toBe("")
  })

  it("reveals a drag handle per card while reordering", async () => {
    const user = userEvent.setup()
    const { getByRole, findAllByLabelText } = wrap(
      <ResourceList items={items} path="/w" onChanged={vi.fn()} />,
    )

    await user.click(getByRole("button", { name: /reorder resources/i }))

    expect(await findAllByLabelText(/drag to reorder/i)).toHaveLength(2)
    expect(getByRole("button", { name: /^done$/i })).toBeInTheDocument()
  })

  it("suppresses card selection while reordering, so a drag can't navigate away", async () => {
    const onSelectResource = vi.fn()
    const user = userEvent.setup()
    const { getByRole, getByText } = wrap(
      <ResourceList
        items={items}
        path="/w"
        onChanged={vi.fn()}
        onSelectResource={onSelectResource}
      />,
    )

    await user.click(getByText("o/r#1"))
    expect(onSelectResource).toHaveBeenCalledTimes(1)

    await user.click(getByRole("button", { name: /reorder resources/i }))
    await user.click(getByText("o/r#1"))
    expect(onSelectResource).toHaveBeenCalledTimes(1)
  })
})
