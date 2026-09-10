import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider, Tooltip } from "@mantine/core"
import { theme } from "./theme"

afterEach(cleanup)

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
