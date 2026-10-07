import { describe, expect, it } from "vitest"
import type { CmuxLayout, CmuxPane, CmuxTreeWorkspace } from "../api/types"
import { applyMove, dropTarget, removePane } from "./cmuxMove"

const tab = (n: number, type = "browser", selected = false) => ({ ref: `surface:${n}`, title: `t${n}`, type, selected })

function workspace(): CmuxTreeWorkspace {
  return {
    id: "W", ref: "workspace:1", title: "ws", selected: false,
    layout: { direction: "horizontal", split: 0.5, children: [{ pane: "pane:1" }, { pane: "pane:2" }] },
    panes: [
      { ref: "pane:1", focused: true, tabs: [tab(1, "terminal", true), tab(2), tab(3)] },
      { ref: "pane:2", focused: false, tabs: [tab(4, "browser", true)] },
    ],
  }
}
const refs = (p: CmuxPane | undefined) => p?.tabs.map((t) => t.ref)

describe("dropTarget", () => {
  const panes = workspace().panes!

  it("same pane, dragged downwards: after the tab dropped on", () => {
    expect(dropTarget(panes, "surface:1", "surface:3")).toEqual({
      surface: "surface:1", type: "terminal", title: "t1", pane: "pane:1",
      anchor: { surface: "surface:3", type: "browser", title: "t3", position: "after" },
    })
  })

  it("same pane, dragged upwards: before the tab dropped on", () => {
    expect(dropTarget(panes, "surface:3", "surface:1")?.anchor?.position).toBe("before")
  })

  it("another pane: before the tab dropped on", () => {
    const m = dropTarget(panes, "surface:2", "surface:4")
    expect(m?.pane).toBe("pane:2")
    expect(m?.anchor).toEqual({ surface: "surface:4", type: "browser", title: "t4", position: "before" })
  })

  it("a pane's empty space: the end of that pane, no anchor", () => {
    expect(dropTarget(panes, "surface:2", "pane:2")).toEqual({ surface: "surface:2", type: "browser", title: "t2", pane: "pane:2" })
  })

  it("no-ops: on itself, or on its own pane while already last", () => {
    expect(dropTarget(panes, "surface:2", "surface:2")).toBeNull()
    expect(dropTarget(panes, "surface:3", "pane:1")).toBeNull()
  })

  it("unknown ids are ignored", () => {
    expect(dropTarget(panes, "surface:99", "surface:1")).toBeNull()
    expect(dropTarget(panes, "surface:1", "pane:9")).toBeNull()
  })

  describe("dropping on a pane's collapsed top group", () => {
    it("lands before the pane's first visible tab", () => {
      // pane:2's first visible tab is surface:4 (its only tab here).
      expect(dropTarget(panes, "surface:2", "pane:2:top", "surface:4")).toEqual({
        surface: "surface:2", type: "browser", title: "t2", pane: "pane:2",
        anchor: { surface: "surface:4", type: "browser", title: "t4", position: "before" },
      })
    })

    it("same-pane no-op: the dragged tab is already the first visible one", () => {
      expect(dropTarget(panes, "surface:1", "pane:1:top", "surface:1")).toBeNull()
    })

    it("without a resolved first-visible ref, does nothing", () => {
      expect(dropTarget(panes, "surface:2", "pane:2:top")).toBeNull()
    })

    it("an unknown pane is ignored", () => {
      expect(dropTarget(panes, "surface:2", "pane:9:top", "surface:4")).toBeNull()
    })
  })
})

describe("applyMove", () => {
  it("reorders within a pane and selects the moved tab", () => {
    const ws = applyMove(workspace(), dropTarget(workspace().panes!, "surface:1", "surface:3")!)
    expect(refs(ws.panes![0])).toEqual(["surface:2", "surface:3", "surface:1"])
    expect(ws.panes![0].tabs.filter((t) => t.selected).map((t) => t.ref)).toEqual(["surface:1"])
  })

  it("moves into another pane before an anchor, focusing that pane", () => {
    const ws = applyMove(workspace(), dropTarget(workspace().panes!, "surface:2", "surface:4")!)
    expect(refs(ws.panes![0])).toEqual(["surface:1", "surface:3"])
    expect(refs(ws.panes![1])).toEqual(["surface:2", "surface:4"])
    expect(ws.panes![1].focused).toBe(true)
    expect(ws.panes![0].focused).toBe(false)
    expect(ws.panes![1].tabs.find((t) => t.selected)?.ref).toBe("surface:2")
  })

  it("moves to the end of a pane", () => {
    const ws = applyMove(workspace(), { surface: "surface:2", type: "browser", title: "t2", pane: "pane:2" })
    expect(refs(ws.panes![1])).toEqual(["surface:4", "surface:2"])
  })

  it("keeps a selection in the source pane when its selected tab leaves", () => {
    const ws = applyMove(workspace(), { surface: "surface:1", type: "terminal", title: "t1", pane: "pane:2" })
    expect(ws.panes![0].tabs.filter((t) => t.selected)).toHaveLength(1)
  })

  it("removes a pane emptied by the move and collapses its split, as cmux does", () => {
    const ws = applyMove(workspace(), { surface: "surface:4", type: "browser", title: "t4", pane: "pane:1" })
    expect(ws.panes!.map((p) => p.ref)).toEqual(["pane:1"])
    expect(ws.layout).toEqual({ pane: "pane:1" })
  })

  it("leaves the workspace alone for an unknown tab", () => {
    const before = workspace()
    expect(applyMove(before, { surface: "surface:99", type: "x", title: "x", pane: "pane:1" })).toBe(before)
  })
})

describe("removePane", () => {
  it("collapses nested splits", () => {
    const layout: CmuxLayout = {
      direction: "horizontal", split: 0.5,
      children: [{ pane: "pane:1" }, { direction: "vertical", split: 0.5, children: [{ pane: "pane:2" }, { pane: "pane:3" }] }],
    }
    expect(removePane(layout, "pane:3")).toEqual({
      direction: "horizontal", split: 0.5, children: [{ pane: "pane:1" }, { pane: "pane:2" }],
    })
    expect(removePane({ pane: "pane:1" }, "pane:1")).toBeNull()
  })
})
