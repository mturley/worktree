import { describe, expect, it } from "vitest"
import type { ResourceDTO, Task, WorktreeSummary } from "../api/types"
import {
  matchResource, matchTask, matchWorktree, parseQuery, rankResource, rankTask, rankText,
} from "./search"
import fixture from "./testdata/search-parity.json"

// The Go twin is TestSearchParityFixture in internal/webui/search_match_test.go;
// both read this one fixture, so the CLI and the web UI cannot drift apart.

interface Want { field: string; snippet: string; via_key?: string; via_field?: string }
interface Case {
  name: string
  kind: "resource" | "task" | "worktree"
  item: Record<string, unknown>
  workspace_titles?: string[]
  resources?: Record<string, unknown>[]
  query: string
  want: Want | null
  rank?: number
}

describe("search parity fixture", () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    it(c.name, () => {
      const terms = parseQuery(c.query)
      let got
      let rank: number | undefined
      if (c.kind === "resource") {
        const r = c.item as unknown as ResourceDTO
        got = matchResource(r, terms)
        rank = rankResource(r, terms)
      } else if (c.kind === "task") {
        const t = c.item as unknown as Task
        got = matchTask(t, terms)
        rank = rankTask(t, terms)
      } else {
        const w = c.item as unknown as WorktreeSummary
        got = matchWorktree(w, c.workspace_titles ?? [], (c.resources ?? []) as unknown as ResourceDTO[], terms)
        rank = rankText(w.branch, terms)
      }
      const flat = got
        ? { field: got.field, snippet: got.snippet, via_key: got.viaKey, via_field: got.viaField }
        : null
      if (c.want === null) expect(flat).toBeNull()
      else expect(flat).toEqual({ via_key: undefined, via_field: undefined, ...c.want })
      if (c.rank !== undefined) expect(rank).toBe(c.rank)
    })
  }
})
