import { afterEach, describe, it, expect } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { BotMark } from "./BotMark"

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function renderMark(props: { authorType?: string; author?: string }) {
  return render(<MantineProvider><BotMark {...props} /></MantineProvider>)
}

afterEach(cleanup)

describe("BotMark", () => {
  it("renders a Bot-labelled mark for a bot", () => {
    renderMark({ authorType: "bot" })
    expect(screen.getByLabelText("Bot")).toBeTruthy()
  })

  it("renders nothing for a user or an unset type", () => {
    renderMark({ authorType: "user" })
    expect(screen.queryByLabelText("Bot")).toBeNull()
    cleanup()
    renderMark({})
    expect(screen.queryByLabelText("Bot")).toBeNull()
  })

  it("names the bot in the tooltip", async () => {
    renderMark({ authorType: "bot", author: "ci-bot" })
    await userEvent.hover(screen.getByLabelText("Bot"))
    expect(await screen.findByText("From a bot: ci-bot")).toBeTruthy()
  })

  it("has a generic tooltip without an author", async () => {
    renderMark({ authorType: "bot" })
    await userEvent.hover(screen.getByLabelText("Bot"))
    expect(await screen.findByText("From a bot")).toBeTruthy()
  })
})
