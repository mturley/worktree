import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Drawer, MantineProvider, Modal, Select, Tooltip } from "@mantine/core"
import { theme } from "./theme"

afterEach(cleanup)

describe("selects", () => {
  it("hides the text cursor in a non-searchable one", () => {
    render(
      <MantineProvider theme={theme} forceColorScheme="dark">
        <Select aria-label="s" data={["a"]} />
      </MantineProvider>,
    )
    const input = screen.getByRole("textbox", { name: "s" })
    // jsdom's computed style drops caret-color, so read the inline style.
    expect(input.style.caretColor).toBe("transparent")
    // No inline cursor: Mantine's own pointer (data-pointer) applies, and an
    // inline one would beat its not-allowed on a disabled Select.
    expect(input.style.cursor).toBe("")
  })

  it("leaves a disabled one's cursor to Mantine", () => {
    render(
      <MantineProvider theme={theme} forceColorScheme="dark">
        <Select aria-label="s" data={["a"]} disabled />
      </MantineProvider>,
    )
    const input = screen.getByRole("textbox", { name: "s" })
    expect(input.style.caretColor).toBe("transparent")
    expect(input.style.cursor).toBe("")
  })

  it("leaves a searchable one alone", () => {
    render(
      <MantineProvider theme={theme} forceColorScheme="dark">
        <Select aria-label="s" data={["a"]} searchable />
      </MantineProvider>,
    )
    const input = screen.getByRole("textbox", { name: "s" })
    expect(input.style.caretColor).toBe("")
    expect(input.style.cursor).toBe("")
  })
})

describe("tooltips in a dark-only app", () => {
  it("paints them dark-on-light-text, not Mantine's inverted default", async () => {
    // Mantine inverts tooltips against the colour scheme, which in a
    // dark-only app makes them the brightest thing on the page.
    render(
      <MantineProvider theme={theme} forceColorScheme="dark">
        <Tooltip label="hello">
          <button type="button">target</button>
        </Tooltip>
      </MantineProvider>,
    )
    await userEvent.hover(screen.getByRole("button", { name: "target" }))
    const tip = await screen.findByText("hello")
    expect(tip.style.getPropertyValue("--tooltip-bg")).toBe("var(--mantine-color-dark-5)")
    expect(tip.style.getPropertyValue("--tooltip-color")).toBe("var(--mantine-color-gray-0)")
  })
})

describe("close buttons on modals and drawers", () => {
  it("hints that Esc closes a Modal", () => {
    render(
      <MantineProvider theme={theme} forceColorScheme="dark">
        <Modal opened onClose={() => {}} title="Thing" transitionProps={{ duration: 0 }}>body</Modal>
      </MantineProvider>,
    )
    expect(screen.getByText("Esc")).toBeInTheDocument()
  })

  it("puts the hint to the right of the X", () => {
    render(
      <MantineProvider theme={theme} forceColorScheme="dark">
        <Modal opened onClose={() => {}} title="Thing" closeButtonProps={{ "aria-label": "Close" }} transitionProps={{ duration: 0 }}>body</Modal>
      </MantineProvider>,
    )
    const close = screen.getByRole("button", { name: "Close" })
    const x = close.querySelector("svg")!
    expect(x.compareDocumentPosition(within(close).getByText("Esc")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("keeps the hint when a Modal sets its own closeButtonProps", () => {
    render(
      <MantineProvider theme={theme} forceColorScheme="dark">
        <Modal opened onClose={() => {}} title="Thing" closeButtonProps={{ "aria-label": "Close" }} transitionProps={{ duration: 0 }}>body</Modal>
      </MantineProvider>,
    )
    expect(within(screen.getByRole("button", { name: "Close" })).getByText("Esc")).toBeInTheDocument()
  })

  it("hints that Esc closes a Drawer", () => {
    render(
      <MantineProvider theme={theme} forceColorScheme="dark">
        <Drawer opened onClose={() => {}} title="Thing" transitionProps={{ duration: 0 }}>body</Drawer>
      </MantineProvider>,
    )
    expect(screen.getByText("Esc")).toBeInTheDocument()
  })
})
