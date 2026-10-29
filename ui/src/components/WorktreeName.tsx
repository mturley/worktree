import type { ReactElement } from "react"
import { useCmuxMatches } from "../api/cmux"
import { worktreeName } from "../lib/homeWorktree"
import { WorktreeGlyph } from "./WorktreeGlyph"
import { WorkspaceLabel, WorktreeHoverCard } from "./tasks/LinkHoverCards"

/**
 * A worktree named as a task's link chip names it: by its cmux workspace,
 * colour bar and title, when it has one, else ⎇ and the worktree's name.
 * `name` stands in for an event without paths, which can only be named.
 */
export function WorktreeName({ path, name }: { path?: string; name?: string }) {
  // No path asks cmux about nothing: an empty path matches no workspace.
  const ws = useCmuxMatches(path ?? "")[0]
  if (ws) return <WorkspaceLabel ws={ws} />
  return (
    <>
      <WorktreeGlyph />
      <span>{name ?? (path ? worktreeName(path) : "")}</span>
    </>
  )
}

/**
 * Hovering `children` shows the worktree's cmux workspaces, name and
 * directory, as a task's link chip does. Without a path there is nothing
 * more to show, so `children` stands alone.
 */
export function WorktreePreview({ path, children }: { path?: string; children: ReactElement }) {
  return path ? <WorktreeHoverCard path={path}>{children}</WorktreeHoverCard> : children
}
