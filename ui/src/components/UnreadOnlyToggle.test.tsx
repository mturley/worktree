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

const thumb = () => document.querySelector<HTMLElement>(".mantine-Switch-thumb")!

describe("UnreadOnlyToggle", () => {
  it("paints the thumb blue only when the page has unreads", () => {
    wrap(false)
    expect(thumb().style.backgroundColor).toBe("")
    cleanup()
    wrap(true)
    expect(thumb().style.backgroundColor).toBe("var(--mantine-color-blue-5)")
  })

  it("shows the U key hint before the label", () => {
    wrap(false)
    const hint = screen.getByText("U")
    expect(hint.tagName).toBe("KBD")
    expect(hint.compareDocumentPosition(screen.getByText("Unreads only")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
