import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SearchContext } from "./SearchContext"
import { SearchHighlight } from "./SearchHighlight"
import { MatchWhy } from "./MatchWhy"
import { AllResourceRow } from "../AllResourceRow"
import { EventRow } from "../EventRow"
import type { AllResourceDTO } from "../../api/types"

const wrap = (ui: React.ReactNode, terms: string[] = []) =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <SearchContext.Provider value={{ terms }}>{ui}</SearchContext.Provider>
      </QueryClientProvider>
    </MantineProvider>,
  )
afterEach(cleanup)

describe("SearchHighlight", () => {
  it("marks matched terms", () => {
    const { container } = wrap(<SearchHighlight text="Fix OAuth proxy" />, ["oauth"])
    expect(container.querySelector("mark")?.textContent).toBe("OAuth")
  })
  it("renders plain text without terms", () => {
    const { container } = wrap(<SearchHighlight text="Fix OAuth proxy" />)
    expect(container.querySelector("mark")).toBeNull()
    expect(screen.getByText("Fix OAuth proxy")).toBeInTheDocument()
  })
})

describe("MatchWhy", () => {
  it("shows hidden-field matches only", () => {
    wrap(<MatchWhy match={{ field: "assignee", snippet: "Mike Turley" }} />, ["turley"])
    expect(screen.getByTestId("match-why").textContent).toBe("assignee: Mike Turley")
    cleanup()
    wrap(<MatchWhy match={{ field: "title", snippet: "x" }} />, ["x"])
    expect(screen.queryByTestId("match-why")).toBeNull()
  })
  it("names the resource for via matches", () => {
    wrap(<MatchWhy match={{ field: "resource", snippet: "Migrate proxy", viaKey: "RHOAIENG-1" }} />, ["proxy"])
    expect(screen.getByTestId("match-why").textContent).toBe("via RHOAIENG-1: Migrate proxy")
  })
})

describe("AllResourceRow", () => {
  it("shows why it matched", () => {
    const r: AllResourceDTO = {
      type: "jira", id: "J-1", url: "u", primary: true, title: "Thing", assignee: "Mike Turley",
      worktrees: [{ path: "/wt/a", repo: "odh", branch: "a" }],
    }
    wrap(<AllResourceRow r={r} />, ["turley"])
    expect(screen.getByTestId("match-why").textContent).toBe("assignee: Mike Turley")
  })
})

describe("EventRow", () => {
  it("shows the body snippet around a body match", () => {
    const e = {
      id: "e1", ts: "2026-09-01T00:00:00Z", external_ts: "", source: "github", type: "pr_comment", type_label: "Comment",
      title: "New comment", body: "x ".repeat(200) + "the oauth cookie", author: "a",
      resource_type: "pr", resource_id: "o/r#1", resource_url: "", resource_title: "", worktrees: [],
      match: { field: "body", snippet: "…x x the oauth cookie" },
    }
    const { container } = wrap(<EventRow e={e} />, ["oauth"])
    expect(container.querySelector("mark")?.textContent).toBe("oauth")
    expect(screen.queryByTestId("match-why")).toBeNull()
  })
})
