import { describe, it, expect } from "vitest"
import type { ResourceDTO, Task, WorktreeSummary } from "../api/types"
import {
  parseQuery, snippet, matchResource, matchTask, matchWorktree, rankResource, rankText, splitHighlight, VISIBLE_FIELDS,
} from "./search"

const jira: ResourceDTO = {
  type: "jira", id: "RHOAIENG-41210", url: "u", primary: true,
  title: "Migrate OAuth proxy", assignee: "Mike Turley", reporter: "Karel Suta", status: "In Review",
  labels: ["dashboard"],
}
const pr: ResourceDTO = { type: "pr", id: "opendatahub-io/odh-dashboard#5123", url: "u", primary: true, title: "fix: expired token", author: "andrew" }
const wt: WorktreeSummary = {
  path: "/wt/odh-oauth-fix", repo: "odh-dashboard", branch: "oauth-proxy-fix",
  on_disk: true, resource_count: 0, primary_count: 0, latest_event_ts: "", primary_by_type: {}, related_count: 0,
  focus_resources: [], notes_search: "switch to the sidecar once kube-rbac lands",
}

describe("parseQuery", () => {
  it("lowercases, splits, dedupes, ignores blank", () => {
    expect(parseQuery("  OAuth  proxy oauth ")).toEqual(["oauth", "proxy"])
    expect(parseQuery("   ")).toEqual([])
  })
})

describe("snippet", () => {
  it("matches the Go rule", () => {
    const long = "alpha ".repeat(10) + "the OAuth   cookie\nis cleared " + "omega ".repeat(10)
    const s = snippet(long, "oauth")
    expect(s.startsWith("…") && s.endsWith("…")).toBe(true)
    expect(s).toContain("the OAuth cookie is cleared")
    expect(snippet("short oauth text", "oauth")).toBe("short oauth text")
    expect(snippet("nothing", "oauth")).toBe("")
  })
})

describe("matchResource", () => {
  it("returns null unless every term matches some field", () => {
    expect(matchResource(jira, ["oauth", "turley"])).not.toBeNull()
    expect(matchResource(jira, ["oauth", "nope"])).toBeNull()
  })
  it("reports the highest-priority field", () => {
    expect(matchResource(jira, ["41210"])?.field).toBe("key")
    expect(matchResource(jira, ["oauth"])?.field).toBe("title")
    expect(matchResource(jira, ["turley"])).toEqual({ field: "assignee", snippet: "Mike Turley" })
    expect(matchResource(jira, ["suta"])?.field).toBe("reporter")
    expect(matchResource(jira, ["review"])?.field).toBe("status")
    expect(matchResource(jira, ["dashboard"])?.field).toBe("labels")
    expect(matchResource(pr, ["andrew"])?.field).toBe("author")
  })
  it("matches the short PR ref", () => {
    expect(matchResource(pr, ["#5123"])?.field).toBe("key")
  })
  it("prefers a custom name and snippets a custom description", () => {
    const named = { ...pr, custom_name: "Token work", custom_description: "a long note about refresh handling" }
    expect(matchResource(named, ["token"])?.field).toBe("name")
    expect(matchResource(named, ["refresh"])).toEqual({ field: "description", snippet: "a long note about refresh handling" })
  })
  it("is null for no terms", () => {
    expect(matchResource(jira, [])).toBeNull()
  })
})

describe("matchWorktree", () => {
  it("matches its own fields in priority order", () => {
    expect(matchWorktree(wt, [], [], ["oauth"])?.field).toBe("branch")
    expect(matchWorktree(wt, ["Dashboard auth"], [], ["auth"])?.field).toBe("branch")
    expect(matchWorktree(wt, ["Kumquat work"], [], ["kumquat"])).toEqual({ field: "workspace", snippet: "Kumquat work" })
    expect(matchWorktree(wt, [], [], ["sidecar"])).toEqual({ field: "notes", snippet: "switch to the sidecar once kube-rbac lands" })
  })
  it("matches via a resource, naming it", () => {
    expect(matchWorktree(wt, [], [jira], ["turley"])).toEqual({
      field: "resource", snippet: "Migrate OAuth proxy", viaKey: "RHOAIENG-41210",
      viaType: "jira", viaId: "RHOAIENG-41210", viaField: "assignee",
    })
  })
  it("matches the worktree's name, not the path it lives under", () => {
    expect(matchWorktree(wt, [], [], ["odh-oauth-fix"])).toEqual({ field: "name", snippet: "odh-oauth-fix" })
    expect(matchWorktree(wt, [], [], ["wt"])).toBeNull()
  })
  it("ANDs terms across own fields and resources", () => {
    expect(matchWorktree(wt, [], [jira], ["sidecar", "turley"])).not.toBeNull()
    expect(matchWorktree(wt, [], [jira], ["sidecar", "nope"])).toBeNull()
  })
})

describe("ranking", () => {
  it("exact key beats title prefix beats title contains beats other", () => {
    expect(rankResource(jira, ["rhoaieng-41210"])).toBe(0)
    expect(rankResource(jira, ["migrate"])).toBe(1)
    expect(rankResource(jira, ["oauth"])).toBe(2)
    expect(rankResource(jira, ["turley"])).toBe(3)
    expect(rankText("oauth-proxy-fix", ["oauth"])).toBe(1)
  })
})

describe("splitHighlight", () => {
  it("marks every case-insensitive occurrence of any term", () => {
    expect(splitHighlight("Fix OAuth and oauth", ["oauth"])).toEqual([
      { text: "Fix ", hit: false }, { text: "OAuth", hit: true }, { text: " and ", hit: false }, { text: "oauth", hit: true },
    ])
    expect(splitHighlight("plain", [])).toEqual([{ text: "plain", hit: false }])
  })
  it("highlights the longest overlapping term whole", () => {
    expect(splitHighlight("OAuth", ["o", "oauth"])).toEqual([{ text: "OAuth", hit: true }])
  })
})

it("title, name, key, branch and repo matches need no why line", () => {
  expect(["title", "name", "key", "branch", "repo", "workspace"].every((f) => VISIBLE_FIELDS.has(f))).toBe(true)
  expect(VISIBLE_FIELDS.has("notes")).toBe(false)
})

describe("matchTask", () => {
  const task: Task = {
    id: 1, ref: "T1", title: "Fix OAuth proxy", description: "alpha ".repeat(10) + "remember the sidecar cookie " + "omega ".repeat(10),
    state: "not_started", priority: "none", starred: false, rank: "a", created_at: "", updated_at: "",
    archived: false, links: [], implicit_worktrees: [], subtasks_total: 0, subtasks_done: 0, blocked: false, blocker_count: 0, blocker_labels: [],
  }

  it("is null with no terms", () => {
    expect(matchTask(task, [])).toBeNull()
  })

  it("matches the title first, whole", () => {
    expect(matchTask(task, ["oauth"])).toEqual({ field: "title", snippet: "Fix OAuth proxy" })
  })

  it("matches the description with a snippet", () => {
    const m = matchTask(task, ["sidecar"])
    expect(m?.field).toBe("description")
    expect(m?.snippet.startsWith("…")).toBe(true)
    expect(m?.snippet).toContain("remember the sidecar cookie")
  })

  it("needs every term somewhere across title and description", () => {
    expect(matchTask(task, ["proxy", "sidecar"])?.field).toBe("title")
    expect(matchTask(task, ["proxy", "nope"])).toBeNull()
  })
})
