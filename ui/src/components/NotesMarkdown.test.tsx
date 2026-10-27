import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { NotesMarkdown } from "./NotesMarkdown"

const md = "![shot](https://example.com/pixel.png)"
const renderMd = (props: Partial<React.ComponentProps<typeof NotesMarkdown>> = {}) =>
  render(<MantineProvider><NotesMarkdown text={md} {...props} /></MantineProvider>)

afterEach(cleanup)

describe("NotesMarkdown", () => {
  it("renders images by default", () => {
    const { container } = renderMd()
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/pixel.png")
  })

  it("renders images as links with imagesAsLinks", () => {
    const { container } = renderMd({ imagesAsLinks: true })
    expect(container.querySelector("img")).toBeNull()
    const link = screen.getByRole("link", { name: "shot" })
    expect(link.getAttribute("href")).toBe("https://example.com/pixel.png")
    expect(link.getAttribute("rel")).toBe("noreferrer")
  })

  it("names an image link by its URL when it has no alt text", () => {
    render(<MantineProvider><NotesMarkdown text="![](https://example.com/a.png)" imagesAsLinks /></MantineProvider>)
    expect(screen.getByRole("link", { name: "https://example.com/a.png" })).toBeTruthy()
  })
})
