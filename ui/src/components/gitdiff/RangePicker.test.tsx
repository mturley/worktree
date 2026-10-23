import { describe, expect, it } from "vitest"
import { useState } from "react"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { Commit, DiffRange } from "../../api/types"
import { RangePicker } from "./RangePicker"

// Newest first, as the commits endpoint returns them.
const commits: Commit[] = ["d", "c", "b", "a"].map((s) => ({
  sha: `${s}${s}${s}`,
  short: s.repeat(3),
  subject: `commit ${s}`,
  author: "me",
  date: new Date().toISOString(),
}))

function Harness({ initial = "all" as DiffRange, list = commits }: { initial?: DiffRange; list?: Commit[] }) {
  const [range, setRange] = useState<DiffRange>(initial)
  return (
    <>
      <RangePicker commits={list} uncommittedCount={2} range={range} onChange={setRange} labelPosition="left" />
      <output data-testid="range">{JSON.stringify(range)}</output>
    </>
  )
}

const setup = async (initial?: DiffRange) => {
  const user = userEvent.setup()
  render(
    <MantineProvider>
      <Harness initial={initial} />
    </MantineProvider>,
  )
  await user.click(screen.getByTestId("range-picker-trigger"))
  await screen.findByRole("dialog")
  return user
}

const range = () => JSON.parse(screen.getByTestId("range").textContent ?? "null")
const row = (name: RegExp) => screen.getByRole("button", { name })
const box = (name: RegExp) => screen.getByRole("checkbox", { name })
const trigger = () => screen.getByTestId("range-picker-trigger")

describe("RangePicker", () => {
  it("labels the control and shows the quick options and hint", async () => {
    await setup()
    expect(screen.getByText("Changes from:")).toBeInTheDocument()
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("button", { name: "All commits" })).toBeInTheDocument()
    expect(within(dialog).getByText(/shift-click/i)).toBeInTheDocument()
    // Uncommitted heads the list, with its file count.
    expect(row(/^uncommitted changes.*2 files/i)).toBeInTheDocument()
  })

  it("click selects just that row", async () => {
    const user = await setup()
    await user.click(row(/commit c/))
    expect(range()).toEqual({ from: "ccc", to: "ccc" })
    expect(trigger()).toHaveTextContent("1 commit")
  })

  it("shift-click selects the run from the last clicked row", async () => {
    const user = await setup()
    await user.click(row(/commit d/))
    await user.keyboard("{Shift>}")
    await user.click(row(/commit b/))
    await user.keyboard("{/Shift}")
    // from is the oldest of the run, to the newest.
    expect(range()).toEqual({ from: "bbb", to: "ddd" })
    expect(trigger()).toHaveTextContent("3 of 4 commits")
  })

  it("checking a row outside the run fills the gap", async () => {
    const user = await setup()
    await user.click(row(/commit d/))
    await user.click(box(/commit a/))
    expect(range()).toEqual({ from: "aaa", to: "ddd" })
    // Every commit, picked by hand, is still "All commits".
    expect(trigger()).toHaveTextContent("All commits")
    await user.click(box(/uncommitted/i))
    expect(range()).toBe("all")
    expect(trigger()).toHaveTextContent("All changes")
  })

  it("unchecking an end trims the run, and middle rows can't be unchecked", async () => {
    const user = await setup({ from: "aaa", to: "ddd" })
    expect(box(/commit c/)).toBeDisabled()
    expect(box(/commit b/)).toBeDisabled()
    await user.click(box(/commit d/))
    expect(range()).toEqual({ from: "aaa", to: "ccc" })
    await user.click(box(/commit a/))
    expect(range()).toEqual({ from: "bbb", to: "ccc" })
    expect(trigger()).toHaveTextContent("2 of 4 commits")
  })

  it("explains a disabled middle checkbox", async () => {
    const user = await setup({ from: "aaa", to: "ddd" })
    await user.hover(box(/commit c/).closest("[data-middle]")!)
    expect(
      await screen.findByText("Commits between the ends stay selected — trim from either end."),
    ).toBeInTheDocument()
  })

  it("quick options set the whole range", async () => {
    const user = await setup()
    await user.click(screen.getByRole("button", { name: "Uncommitted changes" }))
    expect(range()).toEqual({ from: "uncommitted", to: "uncommitted" })
    expect(trigger()).toHaveTextContent("Uncommitted changes")
    await user.click(trigger())
    await user.click(await screen.findByRole("button", { name: "All commits" }))
    expect(range()).toEqual({ from: "aaa", to: "ddd" })
  })
})
