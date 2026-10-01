import { afterEach, describe, it, expect, vi } from "vitest"
import { act, render, cleanup, fireEvent } from "@testing-library/react"
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

describe("ResourceList drag handles", () => {
  const items = [
    { type: "pr", id: "o/r#1", url: "u", primary: true },
    { type: "pr", id: "o/r#2", url: "u", primary: true },
    { type: "jira", id: "RH-9", url: "u", primary: false },
  ]

  it("has no reorder mode to enter: cards are draggable all the time", () => {
    const { queryByRole } = wrap(<ResourceList items={items} path="/w" onChanged={vi.fn()} />)
    expect(queryByRole("button", { name: /reorder resources/i })).not.toBeInTheDocument()
    expect(queryByRole("button", { name: /^done$/i })).not.toBeInTheDocument()
  })

  it("puts a drag handle on every card, all the time", () => {
    const { getAllByRole } = wrap(<ResourceList items={items} path="/w" onChanged={vi.fn()} />)
    expect(getAllByRole("button", { name: /drag to reorder/i })).toHaveLength(3)
  })

  it("needs no hint text: the handles say it", () => {
    const { queryByText } = wrap(<ResourceList items={items} path="/w" onChanged={vi.fn()} />)
    expect(queryByText("Drag to reorder")).not.toBeInTheDocument()
  })

  it("does not start a drag from the card body, so a swipe there stays a click", () => {
    // Only the handle drags. Pressing the card itself and moving is not a
    // drag at all, so the release still selects.
    const onSelectResource = vi.fn()
    const { getByText } = wrap(
      <ResourceList items={items} path="/w" onChanged={vi.fn()} onSelectResource={onSelectResource} />,
    )
    const card = getByText("o/r#1")
    act(() => {
      fireEvent.mouseDown(card, { button: 0, clientX: 10, clientY: 10 })
      fireEvent.mouseMove(document, { button: 0, clientX: 10, clientY: 60 })
      fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 60 })
    })
    fireEvent.click(card)
    expect(onSelectResource).toHaveBeenCalledTimes(1)
  })

  it("still selects a card on a plain click", async () => {
    const onSelectResource = vi.fn()
    const user = userEvent.setup()
    const { getByText } = wrap(
      <ResourceList items={items} path="/w" onChanged={vi.fn()} onSelectResource={onSelectResource} />,
    )
    await user.click(getByText("o/r#1"))
    expect(onSelectResource).toHaveBeenCalledWith({ type: "pr", id: "o/r#1" })
  })

  it("does not select the card a drag was released on", () => {
    // The dragged card follows the pointer, so the mouseup lands on it and
    // the browser fires a click there. Without swallowing that click, every
    // drop would also open the resource you just moved.
    //
    // Fake timers because dnd-kit removes its click-swallowing listener 50ms
    // after a drag ends. Left on real timers, that listener outlives this test
    // and eats the next test's click.
    vi.useFakeTimers()
    try {
      const onSelectResource = vi.fn()
      const { getByText, getByRole } = wrap(
        <ResourceList items={items} path="/w" onChanged={vi.fn()} onSelectResource={onSelectResource} />,
      )
      const card = getByText("o/r#1")
      const handle = getByRole("button", { name: "drag to reorder o/r#1" })
      act(() => {
        fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.mouseMove(document, { button: 0, clientX: 10, clientY: 60 })
        fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 60 })
      })
      fireEvent.click(card)
      expect(onSelectResource).not.toHaveBeenCalled()
    } finally {
      act(() => {
        vi.runAllTimers()
      })
      vi.useRealTimers()
    }
  })

  it("does not swallow the click after a press too short to be a drag", () => {
    const onSelectResource = vi.fn()
    const { getByText, getByRole } = wrap(
      <ResourceList items={items} path="/w" onChanged={vi.fn()} onSelectResource={onSelectResource} />,
    )
    const card = getByText("o/r#1")
    const handle = getByRole("button", { name: "drag to reorder o/r#1" })
    act(() => {
      fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 10 })
      fireEvent.mouseMove(document, { button: 0, clientX: 11, clientY: 11 })
      fireEvent.mouseUp(document, { button: 0, clientX: 11, clientY: 11 })
    })
    fireEvent.click(card)
    expect(onSelectResource).toHaveBeenCalledTimes(1)
  })
})
