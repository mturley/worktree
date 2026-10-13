import { describe, expect, it } from "vitest"
import type { PollLogEntry } from "../api/types"
import { appendOlder, formatBytes, httpSummary, mergeNewer, scopeParams } from "./watcherLog"

const e = (id: number, over: Partial<PollLogEntry> = {}): PollLogEntry => ({
  id, ts: "2026-10-13T13:18:32.000000Z", source: "github", level: "info", kind: "poll",
  message: `m${id}`, resources: [], ...over,
})

describe("scopeParams", () => {
  it("resource wins over worktree", () => {
    const p = scopeParams({ worktree: "/w", resource: { type: "slack", id: "C1:1.2", name: "t" } })
    expect(p.get("resource")).toBe("slack:C1:1.2")
    expect(p.has("worktree")).toBe(false)
  })
  it("worktree only", () => expect(scopeParams({ worktree: "/w" }).get("worktree")).toBe("/w"))
  it("unscoped is empty", () => expect(scopeParams({}).toString()).toBe(""))
})

describe("mergeNewer / appendOlder", () => {
  it("prepends newer rows without duplicates, newest first", () => {
    expect(mergeNewer([e(3), e(2)], [e(5), e(4), e(3)]).map((x) => x.id)).toEqual([5, 4, 3, 2])
  })
  it("appends older rows without duplicates", () => {
    expect(appendOlder([e(5), e(4)], [e(4), e(2), e(1)]).map((x) => x.id)).toEqual([5, 4, 2, 1])
  })
})

describe("httpSummary", () => {
  it("formats an http row", () => {
    const row = e(1, { kind: "http", method: "POST", endpoint: "api.github.com/graphql", http_status: 504, duration_ms: 12300, bytes: 1229 })
    expect(httpSummary(row)).toBe("POST api.github.com/graphql → 504 · 12.3 s · 1.2 KB")
  })
  it("transport failure has no status", () => {
    expect(httpSummary(e(1, { kind: "http", method: "GET", endpoint: "x/y", duration_ms: 40 }))).toBe("GET x/y → failed · 40 ms")
  })
  it("non-http rows return null", () => expect(httpSummary(e(1))).toBeNull())
})

describe("formatBytes", () => {
  it.each([[512, "512 B"], [1229, "1.2 KB"], [3_400_000, "3.2 MB"]])("%d → %s", (n, s) => expect(formatBytes(n)).toBe(s))
})
