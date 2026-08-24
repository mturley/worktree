import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { Mention } from "./Mention"

afterEach(cleanup)

describe("Mention", () => {
  it("renders its label as a marked-up pill", () => {
    render(<Mention>@ana</Mention>)
    const el = screen.getByText("@ana")
    expect(el).toHaveAttribute("data-slack-mention", "true")
  })
})
