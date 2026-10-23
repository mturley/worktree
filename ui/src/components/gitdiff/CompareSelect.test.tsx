import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { CompareSelect } from "./CompareSelect"

// jsdom has no scrollIntoView, which the Select's dropdown calls on open.
const original = Element.prototype.scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})
afterAll(() => {
  Element.prototype.scrollIntoView = original
})

const setup = (tracking?: string) => {
  const onChange = vi.fn()
  render(
    <MantineProvider>
      <CompareSelect value="merge-base" onChange={onChange} mainUpstream="upstream/main" tracking={tracking} labelPosition="left" />
    </MantineProvider>,
  )
  return { onChange, user: userEvent.setup() }
}

describe("CompareSelect", () => {
  it("names the refs and switches base", async () => {
    const { onChange, user } = setup("origin/feature")
    expect(screen.getByText("Compare with:")).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Compare with" })).toHaveValue("merge base (upstream/main)")
    await user.click(screen.getByRole("textbox", { name: "Compare with" }))
    await user.click(await screen.findByRole("option", { name: "tracking branch (origin/feature)" }))
    expect(onChange).toHaveBeenCalledWith("tracking")
  })

  it("reads as a menu button, with no text caret", () => {
    setup("origin/feature")
    const input = screen.getByRole("textbox", { name: "Compare with" })
    // jsdom computes neither, so read the inline style Mantine writes.
    expect(input.style.cursor).toBe("pointer")
    expect(input.style.caretColor).toBe("transparent")
  })

  it("disables the tracking option when there is none", async () => {
    const { onChange, user } = setup(undefined)
    await user.click(screen.getByRole("textbox", { name: "Compare with" }))
    const option = await screen.findByRole("option", { name: "tracking branch (none)" })
    expect(option).toHaveAttribute("data-combobox-disabled")
    await user.click(option)
    expect(onChange).not.toHaveBeenCalled()
  })
})
