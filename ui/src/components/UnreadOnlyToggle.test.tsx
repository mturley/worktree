import { afterEach, describe, it, expect } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { UnreadOnlyToggle } from "./UnreadOnlyToggle"

afterEach(cleanup)

const wrap = (hasUnread: boolean) =>
  render(
    <MantineProvider>
      <UnreadOnlyToggle value={false} onChange={() => {}} hasUnread={hasUnread} />
    </MantineProvider>,
  )

describe("UnreadOnlyToggle", () => {
  it("shows the unread dot only when the page has unreads", () => {
    wrap(false)
    expect(screen.queryByRole("img", { name: "has unreads" })).not.toBeInTheDocument()
    cleanup()
    wrap(true)
    expect(screen.getByRole("img", { name: "has unreads" })).toBeInTheDocument()
  })

  it("shows the U key hint", () => {
    wrap(false)
    expect(screen.getByText("U").tagName).toBe("KBD")
  })
})
