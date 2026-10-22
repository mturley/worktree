import type { TaskLink, TaskLinkTarget } from "../../../api/types"
import { shortResourceRef } from "../../../lib/resourceRef"

/** The link route body that names `l`. */
export function linkTarget(l: TaskLink): TaskLinkTarget {
  return l.kind === "worktree"
    ? { kind: "worktree", path: l.worktree ?? "" }
    : { kind: "resource", type: l.resource_type ?? "", rid: l.resource_id ?? "" }
}

/** A stable string identity for a link target: "res:<type>:<id>" or "wt:<path>". */
export function targetKey(t: TaskLinkTarget): string {
  return t.kind === "worktree" ? `wt:${t.path}` : `res:${t.type}:${t.rid}`
}

export const linkKey = (l: TaskLink) => targetKey(linkTarget(l))

/** "#4521" for "pr:o/r#4521", the key for Jira; the raw ref when nothing shorter exists. */
export function viaRef(typeId: string): string {
  const i = typeId.indexOf(":")
  if (i < 0) return typeId
  const type = typeId.slice(0, i)
  const id = typeId.slice(i + 1)
  return shortResourceRef(type, id) || (type === "slack" ? "Slack thread" : id)
}

export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}
