import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { worktreeName } from "./homeWorktree"
import { shortResourceRef } from "./resourceRef"

/**
 * Search: pure matching for worktrees and resources, which the pages filter
 * in the browser. Events are matched on the server (`q` on the timeline
 * endpoints, internal/webui/search.go) with the same rules: case-insensitive
 * whitespace-separated terms, every term must match somewhere.
 */

/**
 * Whether a worktree matches through its resources' fields. The one switch
 * for that behaviour, kept because it may prove too broad in use.
 */
export const MATCH_WORKTREES_VIA_RESOURCES = true

export interface SearchMatch {
  /** Which field matched, e.g. "title", "assignee", "notes", "resource". */
  field: string
  /** Text to show for it: the field's value or a snippet around the hit. */
  snippet: string
  /** For a worktree matched through a resource: that resource's short key. */
  viaKey?: string
  /** For a via match: the resource's type and id, and which of its fields hit. */
  viaType?: string
  viaId?: string
  viaField?: string
}

/** Fields already visible as the item's title; no "why" line for them. */
export const VISIBLE_FIELDS: ReadonlySet<string> = new Set(["title", "name", "key", "branch", "repo", "workspace"])

export function parseQuery(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))]
}

const SNIPPET_RADIUS = 30

/** Same rule as snippet() in internal/webui/search.go. */
export function snippet(text: string, term: string): string {
  const flat = [...text.split(/\s+/).filter(Boolean).join(" ")]
  const low = flat.map((c) => c.toLowerCase())
  const tr = [...term]
  let at = -1
  for (let i = 0; i + tr.length <= low.length; i++) {
    if (low.slice(i, i + tr.length).join("") === term) { at = i; break }
  }
  if (at < 0) return ""
  let start = at - SNIPPET_RADIUS
  let end = at + tr.length + SNIPPET_RADIUS
  const cutStart = start > 0
  const cutEnd = end < flat.length
  if (!cutStart) start = 0
  else while (start < at && flat[start - 1] !== " ") start++
  if (!cutEnd) end = flat.length
  else while (end > at + tr.length && flat[end] !== " ") end--
  let out = flat.slice(start, end).join("").trim()
  if (cutStart) out = "…" + out
  if (cutEnd) out += "…"
  return out
}

export function resourceLabel(r: ResourceDTO): string {
  return r.custom_name || r.title || r.id
}

type Field = { name: string; text: string; long?: boolean }

function resourceFields(r: ResourceDTO): Field[] {
  return [
    { name: "key", text: `${r.id}\n${shortResourceRef(r.type, r.id)}\n${r.channel_name ?? ""}` },
    { name: "name", text: r.custom_name ?? "" },
    { name: "title", text: r.title ?? "" },
    { name: "description", text: r.custom_description ?? "", long: true },
    { name: "assignee", text: r.assignee ?? "" },
    { name: "author", text: r.author ?? "" },
    { name: "reporter", text: r.reporter ?? "" },
    { name: "status", text: r.status ?? r.state ?? "" },
    { name: "labels", text: (r.labels ?? []).join(", ") },
    { name: "description", text: r.description ?? "", long: true },
    { name: "url", text: r.type === "link" ? r.url : "" },
  ]
}

function allTermsHit(lowerTexts: string[], terms: string[]): boolean {
  return terms.every((t) => lowerTexts.some((l) => l.includes(t)))
}

/** The highest-priority field containing any term, as a match. */
function firstHit(fields: Field[], terms: string[]): SearchMatch | null {
  for (const f of fields) {
    const low = f.text.toLowerCase()
    const t = terms.find((term) => low.includes(term))
    if (t === undefined) continue
    return { field: f.name, snippet: f.long ? snippet(f.text, t) : f.text }
  }
  return null
}

export function matchResource(r: ResourceDTO, terms: string[]): SearchMatch | null {
  if (terms.length === 0) return null
  const fields = resourceFields(r)
  if (!allTermsHit(fields.map((f) => f.text.toLowerCase()), terms)) return null
  return firstHit(fields, terms)
}

export function matchWorktree(
  w: WorktreeSummary,
  workspaceTitles: string[],
  resources: ResourceDTO[],
  terms: string[],
): SearchMatch | null {
  if (terms.length === 0) return null
  const own: Field[] = [
    { name: "branch", text: w.branch },
    { name: "repo", text: w.repo },
    { name: "name", text: worktreeName(w.path) },
    ...workspaceTitles.map((t) => ({ name: "workspace", text: t })),
    { name: "notes", text: w.notes_search ?? "", long: true },
  ]
  const via = MATCH_WORKTREES_VIA_RESOURCES ? resources : []
  const texts = [
    ...own.map((f) => f.text.toLowerCase()),
    ...via.flatMap((r) => resourceFields(r).map((f) => f.text.toLowerCase())),
  ]
  if (!allTermsHit(texts, terms)) return null
  const hit = firstHit(own, terms)
  if (hit) return hit
  for (const r of via) {
    const rHit = firstHit(resourceFields(r), terms)
    if (rHit) {
      return {
        field: "resource", snippet: resourceLabel(r), viaKey: shortResourceRef(r.type, r.id),
        viaType: r.type, viaId: r.id, viaField: rHit.field,
      }
    }
  }
  return null
}

/** 1 label starts with the first term, 2 contains any term, 3 otherwise. */
export function rankText(label: string, terms: string[]): number {
  const low = label.toLowerCase()
  if (terms.length > 0 && low.startsWith(terms[0])) return 1
  if (terms.some((t) => low.includes(t))) return 2
  return 3
}

/** rankText, with 0 for a term that IS the resource's key or short ref. */
export function rankResource(r: ResourceDTO, terms: string[]): number {
  const keys = [r.id.toLowerCase(), shortResourceRef(r.type, r.id).toLowerCase()]
  if (terms.some((t) => keys.includes(t))) return 0
  return rankText(resourceLabel(r), terms)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function splitHighlight(text: string, terms: string[]): { text: string; hit: boolean }[] {
  if (terms.length === 0 || !text) return [{ text, hit: false }]
  // Longest first: a regex alternation takes the first alternative that
  // matches, so ["o", "oauth"] would otherwise mark only the "O" of "OAuth".
  const longestFirst = [...terms].sort((a, b) => b.length - a.length)
  const re = new RegExp(`(${longestFirst.map(escapeRegExp).join("|")})`, "gi")
  return text.split(re).filter((p) => p !== "").map((p) => ({
    text: p, hit: terms.includes(p.toLowerCase()),
  }))
}
