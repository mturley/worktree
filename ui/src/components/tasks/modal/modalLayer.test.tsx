import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MantineProvider, Modal } from "@mantine/core"
import { useState } from "react"
import { ModalLayerProvider, useModalLayer } from "./modalLayer"

function Layered({ title, opened, onClose, children }: {
  title: string
  opened: boolean
  onClose: () => void
  children?: React.ReactNode
}) {
  const { topmost, zIndex, layer } = useModalLayer(opened)
  return (
    <Modal opened={opened} onClose={onClose} closeOnEscape={topmost} zIndex={zIndex} title={title}
      transitionProps={{ duration: 0 }}>
      <ModalLayerProvider layer={layer}>{children}</ModalLayerProvider>
    </Modal>
  )
}

/** A bottom modal with two siblings opened over it, first then second. */
function Siblings() {
  const [bottom, setBottom] = useState(true)
  const [first, setFirst] = useState(true)
  const [second, setSecond] = useState(false)
  return (
    <Layered title="bottom" opened={bottom} onClose={() => setBottom(false)}>
      <button onClick={() => setSecond(true)}>open second</button>
      <Layered title="first" opened={first} onClose={() => setFirst(false)} />
      <Layered title="second" opened={second} onClose={() => setSecond(false)} />
    </Layered>
  )
}

const dialog = (name: string) => screen.queryByRole("dialog", { name })
const z = (el: Element) =>
  Number(getComputedStyle(el.closest("[style*='--mb-z-index']")!).getPropertyValue("--mb-z-index"))

afterEach(cleanup)

describe("useModalLayer", () => {
  it("puts the later of two sibling layers on top: it paints above, and one Esc closes only it", async () => {
    render(<MantineProvider><Siblings /></MantineProvider>)
    await screen.findByRole("dialog", { name: "first" })
    fireEvent.click(screen.getByRole("button", { name: "open second", hidden: true }))
    const second = await screen.findByRole("dialog", { name: "second" })
    expect(z(second)).toBeGreaterThan(z(dialog("first")!))

    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(dialog("second")).toBeNull())
    expect(dialog("first")).not.toBeNull()
    expect(dialog("bottom")).not.toBeNull()

    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(dialog("first")).toBeNull())
    expect(dialog("bottom")).not.toBeNull()

    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(dialog("bottom")).toBeNull())
  })
})
