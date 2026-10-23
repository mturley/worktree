import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { Loading } from "./Loading"

describe("Loading", () => {
  it("shows a spinner beside the text, as a status", () => {
    render(
      <MantineProvider>
        <Loading />
      </MantineProvider>,
    )
    const status = screen.getByRole("status")
    expect(status).toHaveTextContent("Loading…")
    expect(status.querySelector(".mantine-Loader-root")).not.toBeNull()
  })
})
