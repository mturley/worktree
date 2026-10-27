import { useMemo } from "react"
import { useTasks } from "../../hooks/useTasks"
import { TaskCountBadge } from "./TaskCountBadge"

/**
 * "3 OTHER TASKS": the worktree's open tasks that do not link the selected
 * resource, beside a resource pane's "← all resources", so tasks hidden by
 * the selection are not forgotten. Nothing when there are none.
 */
export function OtherTasksBadge({ path, resource }: {
  path: string
  resource: { type: string; id: string }
}) {
  const scope = useMemo(() => ({ kind: "worktree" as const, path }), [path])
  const { data } = useTasks(scope, { completed: false, archived: false })
  const count = useMemo(
    () => (data ?? []).filter((t) =>
      t.state !== "done" &&
      !t.links.some((l) => l.kind === "resource" && l.resource_type === resource.type && l.resource_id === resource.id),
    ).length,
    [data, resource.type, resource.id],
  )
  return <TaskCountBadge count={count} qualifier="other" title={`Open tasks in this worktree not linked to this resource`} />
}
