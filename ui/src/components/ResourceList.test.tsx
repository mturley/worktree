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
const setResourceOrder = vi.fn()
const setResourcePrimary = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      addResource: (...args: unknown[]) => addResource(...args),
      setResourceOrder: (...args: unknown[]) => setResourceOrder(...args),
      setResourcePrimary: (...args: unknown[]) => setResourcePrimary(...args),
    },
  }
})

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

afterEach(() => {
  cleanup()
  addResource.mockReset()
  setResourceOrder.mockReset()
  setResourcePrimary.mockReset()
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
      position: "top",
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

  it("shows no standing hint text: it lives in the handle's hover menu", () => {
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

describe("ResourceList handle hover menu", () => {
  const items = [
    { type: "pr", id: "o/r#1", url: "u", primary: true },
    { type: "pr", id: "o/r#2", url: "u", primary: true },
    { type: "jira", id: "RH-9", url: "u", primary: false },
  ]
  const handle = (getByRole: (role: string, o: object) => HTMLElement, id: string) =>
    getByRole("button", { name: `drag to reorder ${id}` })

  it("opens on hovering a handle, with the hint and the actions", async () => {
    const user = userEvent.setup()
    const { getByRole, findByText, findByRole } = wrap(
      <ResourceList items={items} path="/w" onChanged={vi.fn()} />,
    )
    await user.hover(handle(getByRole, "o/r#2"))
    expect(await findByText("Drag to reorder")).toBeInTheDocument()
    expect(await findByRole("button", { name: "Move to top" })).toBeInTheDocument()
    expect(await findByRole("button", { name: "Move to bottom" })).toBeInTheDocument()
    expect(await findByRole("radio", { name: "Related" })).toBeInTheDocument()
  })

  it("stays open while the pointer crosses the gap from the handle into it", async () => {
    // The whole point of putting buttons in it: they have to be reachable.
    // Between the handle and the menu is a gap that belongs to neither, and a
    // slow, deliberate move (a trackpad, say) can sit in it for a while —
    // measured in a real browser, the old 150ms close delay lost the menu.
    const user = userEvent.setup()
    const { getByRole, findByRole } = wrap(<ResourceList items={items} path="/w" onChanged={vi.fn()} />)
    await user.hover(handle(getByRole, "o/r#2"))
    const button = await findByRole("button", { name: "Move to top" })
    await user.hover(getByRole("heading", { name: "Focus" })) // in the gap: neither handle nor menu
    await new Promise((r) => setTimeout(r, 250))
    await user.hover(button)
    await new Promise((r) => setTimeout(r, 400)) // well past the close delay
    expect(button).toBeInTheDocument()
  })

  it("shows one menu at a time when moving from one handle to the next", async () => {
    // Adjacent cards' menus overlap, so a lingering one could catch a click
    // meant for its neighbour's. Measured in a browser: before grouping, both
    // stayed open together.
    const user = userEvent.setup()
    const { getByRole, findAllByText } = wrap(<ResourceList items={items} path="/w" onChanged={vi.fn()} />)
    await user.hover(handle(getByRole, "o/r#1"))
    expect(await findAllByText("Drag to reorder")).toHaveLength(1)
    await user.hover(handle(getByRole, "o/r#2"))
    await new Promise((r) => setTimeout(r, 350)) // past the open delay, inside the close delay
    expect(await findAllByText("Drag to reorder")).toHaveLength(1)
  })

  it("closes as soon as the card is picked up", async () => {
    // A menu hanging off a card that is sliding around would chase it.
    const user = userEvent.setup()
    const { getByRole, findByText, queryByText } = wrap(
      <ResourceList items={items} path="/w" onChanged={vi.fn()} />,
    )
    const h = handle(getByRole, "o/r#1")
    await user.hover(h)
    await findByText("Drag to reorder")
    vi.useFakeTimers() // dnd-kit's post-drag click listener: see the drop test
    try {
      act(() => {
        fireEvent.mouseDown(h, { button: 0, clientX: 10, clientY: 10 })
        fireEvent.mouseMove(document, { button: 0, clientX: 10, clientY: 60 })
      })
      // Let the menu's exit transition finish — not the close delay, which
      // a drag skips.
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(queryByText("Drag to reorder")).not.toBeInTheDocument()
    } finally {
      // Released here so a failed assertion cannot leave a drag in progress
      // for the next test to trip over.
      act(() => {
        fireEvent.mouseUp(document, { button: 0, clientX: 10, clientY: 60 })
        vi.runAllTimers()
      })
      vi.useRealTimers()
    }
  })

  it("disables the move that would do nothing", async () => {
    const user = userEvent.setup()
    const { getByRole, findByRole } = wrap(<ResourceList items={items} path="/w" onChanged={vi.fn()} />)
    await user.hover(handle(getByRole, "o/r#1"))
    expect(await findByRole("button", { name: "Move to top" })).toBeDisabled()
    expect(await findByRole("button", { name: "Move to bottom" })).toBeEnabled()
  })

  it("moves a card to the top of its group and saves the order", async () => {
    setResourceOrder.mockResolvedValue(null)
    const onChanged = vi.fn()
    const user = userEvent.setup()
    const { getByRole, findByRole } = wrap(<ResourceList items={items} path="/w" onChanged={onChanged} />)
    await user.hover(handle(getByRole, "o/r#2"))
    await user.click(await findByRole("button", { name: "Move to top" }))
    expect(setResourceOrder).toHaveBeenCalledWith({
      path: "/w",
      focus: [{ type: "pr", id: "o/r#2" }, { type: "pr", id: "o/r#1" }],
      related: [{ type: "jira", id: "RH-9" }],
    })
  })

  it("saves the full order when a filter hides some cards", async () => {
    // Saving only the shown cards would send the hidden one to the bottom:
    // the server appends whatever an order leaves out.
    setResourceOrder.mockResolvedValue(null)
    const hidden = { ...items[0], id: "o/r#3" }
    const all = [items[0], hidden, ...items.slice(1)]
    const user = userEvent.setup()
    const { getByRole, findByRole, queryByText } = wrap(
      <ResourceList items={items} allItems={all} path="/w" onChanged={vi.fn()} />,
    )
    expect(queryByText(/o\/r#3/)).not.toBeInTheDocument()
    await user.hover(handle(getByRole, "o/r#2"))
    await user.click(await findByRole("button", { name: "Move to top" }))
    expect(setResourceOrder).toHaveBeenCalledWith({
      path: "/w",
      focus: [{ type: "pr", id: "o/r#2" }, { type: "pr", id: "o/r#1" }, { type: "pr", id: "o/r#3" }],
      related: [{ type: "jira", id: "RH-9" }],
    })
  })

  it("shows the given empty text when nothing is left to show", () => {
    const { getByText } = wrap(
      <ResourceList items={[]} allItems={items} emptyText="No resources with unread events" path="/w" onChanged={vi.fn()} />,
    )
    expect(getByText("No resources with unread events")).toBeInTheDocument()
  })

  it("reclassifies from the menu's Focus/Related toggle", async () => {
    setResourcePrimary.mockResolvedValue(null)
    const user = userEvent.setup()
    const { getByRole, findByRole } = wrap(<ResourceList items={items} path="/w" onChanged={vi.fn()} />)
    await user.hover(handle(getByRole, "o/r#1"))
    await user.click(await findByRole("radio", { name: "Related" }))
    expect(setResourcePrimary).toHaveBeenCalledWith({ path: "/w", type: "pr", id: "o/r#1", primary: false })
  })
})
