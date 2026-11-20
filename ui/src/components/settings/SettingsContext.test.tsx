import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("../SettingsModal", () => ({
  SettingsModal: ({ opened, target }: { opened: boolean; target?: { tab: string } }) => (
    <div data-testid="modal" data-opened={String(opened)} data-tab={target?.tab ?? ""} />
  ),
}))

import { SettingsProvider } from "./SettingsContext"

const wrap = (url: string) => {
  window.history.replaceState({}, "", url)
  return render(<SettingsProvider><span /></SettingsProvider>)
}
const modal = () => screen.getByTestId("modal")

beforeEach(() => window.history.replaceState({}, "", "/"))
afterEach(cleanup)

describe("SettingsProvider ?settings deep link", () => {
  it("opens Settings from ?settings", () => {
    wrap("/?settings&home=x")
    expect(modal().dataset.opened).toBe("true")
    expect(modal().dataset.tab).toBe("")
    expect(window.location.search).toBe("?home=x")
  })

  it("opens a tab from ?settings=devices", () => {
    wrap("/?settings=devices")
    expect(modal().dataset.opened).toBe("true")
    expect(modal().dataset.tab).toBe("devices")
    expect(window.location.search).toBe("")
  })

  it("ignores an unknown tab", () => {
    wrap("/?settings=bogus")
    expect(modal().dataset.opened).toBe("true")
    expect(modal().dataset.tab).toBe("")
  })

  it("does not open without the param", () => {
    wrap("/?home=x")
    expect(modal().dataset.opened).toBe("false")
    expect(window.location.search).toBe("?home=x")
  })
})
