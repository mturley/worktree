import { useMemo } from "react"
import { useTasks } from "../../hooks/useTasks"
import { TaskCountBadge } from "./TaskCountBadge"

/**
 * "3 OTHER TASKS": the worktree's open tasks that do not link the selected
 * resource, beside a resource pane's "← all resources", so tasks hidden by
 * the selection are not forgotten. Just "3 TASKS" when the resource has no
 * open tasks of its own, as there is nothing for them to be other than.
 * Nothing when there are none.
 */
export function OtherTasksBadge({ path, resource }: {
  path: string
  resource: { type: string; id: string }
}) {
  const scope = useMemo(() => ({ kind: "worktree" as const, path }), [path])
  const { data } = useTasks(scope, { completed: false, archived: false })
  const { others, own } = useMemo(() => {
    const open = (data ?? []).filter((t) => t.state !== "done")
    const links = (t: (typeof open)[number]) =>
      t.links.some((l) => l.kind === "resource" && l.resource_type === resource.type && l.resource_id === resource.id)
    const own = open.filter(links).length
    return { others: open.length - own, own }
  }, [data, resource.type, resource.id])
  return (
    <TaskCountBadge
      count={others}
      qualifier={own > 0 ? "other" : undefined}
      title={own > 0 ? "Open tasks in this worktree not linked to this resource" : "Open tasks in this worktree"}
    />
  )
}
