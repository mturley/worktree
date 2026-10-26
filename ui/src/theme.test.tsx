import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider, Select, Tooltip } from "@mantine/core"
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
