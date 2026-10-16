import { describe, expect, it } from "vitest"
import type { LinkedItem, LinkedSection, LinkedTreeNode } from "../api/types"
import { matchLinkedItem } from "./search"
import { filterLinkedSections } from "./linkedSearch"

const item = (over: Partial<LinkedItem>): LinkedItem => ({ type: "jira", id: "J-1", url: "u", resolved: true, ...over })
const node = (over: Partial<LinkedTreeNode>): LinkedTreeNode =>
  ({ type: "jira", id: "J-1", url: "u", resolved: true, expanded: false, has_children: false, ...over })

describe("matchLinkedItem", () => {
  it("matches key, short ref, title, status, issue type, channel, domain, excerpt and link context", () => {
    expect(matchLinkedItem(item({ id: "RHOAIENG-5" }), ["rhoaieng-5"])?.field).toBe("key")
    expect(matchLinkedItem(item({ type: "pr", id: "o/r#42" }), ["#42"])?.field).toBe("key")
    expect(matchLinkedItem(item({ title: "Migrate proxy" }), ["proxy"])?.field).toBe("title")
    expect(matchLinkedItem(item({ status: "In Review" }), ["review"])?.field).toBe("status")
    expect(matchLinkedItem(item({ issue_type: "Epic" }), ["epic"])?.field).toBe("issue type")
    expect(matchLinkedItem(item({ type: "slack", channel_name: "wg-zaffre" }), ["zaffre"])).not.toBeNull()
    expect(matchLinkedItem(item({ type: "link", domain: "docs.google.com" }), ["google"])).not.toBeNull()
    expect(matchLinkedItem(item({ type: "slack", excerpt: "kumquat plan" }), ["kumquat"])).not.toBeNull()
    expect(matchLinkedItem(item({ context: { before: "see the", label: "design", after: "for persimmon" } }), ["persimmon"]))
      .not.toBeNull()
  })
  it("needs every term", () => {
    expect(matchLinkedItem(item({ title: "Migrate proxy" }), ["proxy", "nope"])).toBeNull()
    expect(matchLinkedItem(item({ title: "Migrate proxy", status: "Done" }), ["proxy", "done"])).not.toBeNull()
  })
})

describe("filterLinkedSections", () => {
  const sections: LinkedSection[] = [
    { kind: "description", title: "Description", items: [item({ id: "A-1", title: "Kumquat" }), item({ id: "A-2", title: "Other" })] },
    { kind: "links", title: "Linked work items", groups: [
      { label: "blocks", items: [item({ id: "B-1", title: "Nope" })] },
      { label: "relates to", items: [item({ id: "B-2", title: "kumquat too" })] },
    ] },
    { kind: "referenced_by", title: "Referenced by", items: [item({ id: "C-1", title: "Unrelated" })] },
    { kind: "git_pr", title: "Git PR", error: "boom" },
  ]

  it("passes everything through with no terms", () => {
    expect(filterLinkedSections(sections, [])).toEqual({ sections, count: null, unsearched: false })
  })

  it("keeps matching items, drops empty groups and sections, keeps errors", () => {
    const out = filterLinkedSections(sections, ["kumquat"])
    expect(out.count).toBe(2)
    expect(out.sections.map((s) => s.kind)).toEqual(["description", "links", "git_pr"])
    expect(out.sections[0].items?.map((i) => i.id)).toEqual(["A-1"])
    expect(out.sections[1].groups).toEqual([{ label: "relates to", items: [item({ id: "B-2", title: "kumquat too" })] }])
    expect(out.sections[2].error).toBe("boom")
  })

  it("keeps tree paths to matches, expanded, and prunes the rest", () => {
    const tree: LinkedTreeNode[] = [node({
      id: "EPIC-1", title: "Epic", has_children: true, children: [
        node({ id: "S-1", title: "Kumquat story", has_children: true, children: [node({ id: "T-1", title: "task" })] }),
        node({ id: "S-2", title: "Other story" }),
      ],
    })]
    const out = filterLinkedSections([{ kind: "hierarchy", title: "Hierarchy", tree }], ["kumquat"])
    expect(out.count).toBe(1)
    const root = out.sections[0].tree![0]
    expect(root.id).toBe("EPIC-1")
    expect(root.expanded).toBe(true)
    expect(root.children!.map((c) => c.id)).toEqual(["S-1"])
    // A match keeps none of its non-matching children.
    expect(root.children![0].children).toEqual([])
    expect(root.children![0].has_children).toBe(false)
  })

  it("flags branches that were never loaded, and doesn't search them", () => {
    const tree: LinkedTreeNode[] = [node({ id: "EPIC-1", title: "Kumquat epic", has_children: null })]
    const out = filterLinkedSections([{ kind: "hierarchy", title: "Hierarchy", tree }], ["kumquat"])
    expect(out.unsearched).toBe(true)
    expect(out.sections[0].tree![0].has_children).toBe(false)
  })
})
