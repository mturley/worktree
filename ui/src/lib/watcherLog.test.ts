import { describe, expect, it } from "vitest"
import type { PollLogEntry, WatchedResourceStatus } from "../api/types"
import { appendOlder, formatBytes, httpSummary, mergeNewer, nextSort, sortResources } from "./watcherLog"

const e = (id: number, over: Partial<PollLogEntry> = {}): PollLogEntry => ({
  id, ts: "2026-10-13T13:18:32.000000Z", source: "github", level: "info", kind: "poll",
  message: `m${id}`, resources: [], ...over,
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

const r = (name: string, over: Partial<WatchedResourceStatus> = {}): WatchedResourceStatus => ({
  type: "pr", id: name, name, worktrees: [], status: "ok", ...over,
})

describe("sortResources", () => {
  const rows = [
    r("b-jira", { type: "jira", status: "never" }),
    r("a-slack", { type: "slack", status: "error", last_success: "2026-10-13T10:00:00.000000Z" }),
    r("c-pr", { type: "pr", last_success: "2026-10-13T12:00:00.000000Z" }),
    r("a-pr", { type: "pr", last_success: "2026-10-13T11:00:00.000000Z" }),
  ]
  const names = (s: Parameters<typeof sortResources>[1]) => sortResources(rows, s).map((x) => x.name)

  it("null sort keeps server order and does not mutate", () => {
    expect(names(null)).toEqual(["b-jira", "a-slack", "c-pr", "a-pr"])
    expect(rows[0].name).toBe("b-jira")
  })
  it("source by label, ties by name", () => {
    expect(names({ column: "source", dir: "asc" })).toEqual(["a-pr", "c-pr", "b-jira", "a-slack"])
    expect(names({ column: "source", dir: "desc" })).toEqual(["a-slack", "b-jira", "c-pr", "a-pr"])
  })
  it("updated: never is oldest", () => {
    expect(names({ column: "updated", dir: "asc" })).toEqual(["b-jira", "a-slack", "a-pr", "c-pr"])
    expect(names({ column: "updated", dir: "desc" })).toEqual(["c-pr", "a-pr", "a-slack", "b-jira"])
  })
  it("status: error, ok, never", () => {
    expect(names({ column: "status", dir: "asc" })).toEqual(["a-slack", "a-pr", "c-pr", "b-jira"])
    expect(names({ column: "status", dir: "desc" })).toEqual(["b-jira", "c-pr", "a-pr", "a-slack"])
  })
})

describe("nextSort", () => {
  it("cycles asc, desc, off on one column", () => {
    const a = nextSort(null, "status")
    expect(a).toEqual({ column: "status", dir: "asc" })
    const b = nextSort(a, "status")
    expect(b).toEqual({ column: "status", dir: "desc" })
    expect(nextSort(b, "status")).toBeNull()
  })
  it("switching column starts at asc", () => {
    expect(nextSort({ column: "status", dir: "desc" }, "source")).toEqual({ column: "source", dir: "asc" })
  })
})
