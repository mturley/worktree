import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import remarkGfm from "remark-gfm"
import rehypeRaw from "rehype-raw"
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

  it("keeps a linked image's own link, not a link inside a link", () => {
    const { container } = render(
      <MantineProvider><NotesMarkdown text="[![build](https://ci.io/badge.svg)](https://ci.io/run/1)" imagesAsLinks /></MantineProvider>,
    )
    const links = container.querySelectorAll("a")
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute("href")).toBe("https://ci.io/run/1")
    expect(links[0].textContent).toBe("build")
  })

  it("shows raw HTML as text by default", () => {
    const { container } = render(<MantineProvider><NotesMarkdown text="a <b>bold</b> b" /></MantineProvider>)
    expect(container.querySelector("b")).toBeNull()
  })

  it("sanitizes whatever rehype plugins it is given", () => {
    const { container } = render(
      <MantineProvider>
        <NotesMarkdown text={"<iframe src=\"https://x.io\"></iframe><b>kept</b>"} plugins={{ remark: [remarkGfm], rehype: [rehypeRaw] }} />
      </MantineProvider>,
    )
    expect(container.querySelector("b")?.textContent).toBe("kept")
    expect(container.querySelector("iframe")).toBeNull()
  })
})

describe("NotesMarkdown conflict markers", () => {
  const conflict = "- [ ] task\n<<<<<<< notes\nx\n=======\ny\n>>>>>>> cmux"

  it("shows markers as text and makes checkboxes inert", () => {
    const { container } = render(
      <MantineProvider><NotesMarkdown text={conflict} onToggleTask={() => {}} /></MantineProvider>,
    )
    expect(container.querySelector("h1, h2")).toBeNull()
    expect(container.textContent).toContain("=======")
    expect(container.querySelector("code")?.textContent).toBe("<<<<<<< notes")
    expect((container.querySelector("input[type=checkbox]") as HTMLInputElement).disabled).toBe(true)
  })

  it("keeps checkboxes clickable for a setext-style =======", () => {
    const { container } = render(
      <MantineProvider><NotesMarkdown text={"Title\n=======\n- [ ] t"} onToggleTask={() => {}} /></MantineProvider>,
    )
    expect((container.querySelector("input[type=checkbox]") as HTMLInputElement).disabled).toBe(false)
  })
})
