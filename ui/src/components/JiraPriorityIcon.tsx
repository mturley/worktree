import { useState } from "react"
import { Badge, Tooltip } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { jiraIconProxy } from "./ResourceStatusIcon"

/**
 * A Jira issue's priority, shown as the icon Jira itself uses for it, with
 * the priority's name in a tooltip. The icon URL cannot be derived from the
 * name (custom priorities point at avatar URLs), so it comes from the cached
 * state. Without one — state cached before the URL was, or a fetch that fails
 * — fall back to the plain text badge rather than losing the priority.
 */
export function JiraPriorityIcon({ r }: { r: ResourceDTO }) {
  const [iconFailed, setIconFailed] = useState(false)
  if (!r.priority) return null
  if (!r.priority_icon_url || iconFailed) {
    return <Badge size="xs" variant="light" color="orange">{r.priority}</Badge>
  }
  const label = `Priority: ${r.priority}`
  return (
    <Tooltip label={label} withinPortal>
      <img
        src={jiraIconProxy(r.priority_icon_url)}
        alt={label}
        width={16}
        height={16}
        onError={() => setIconFailed(true)}
        style={{ flexShrink: 0, display: "block" }}
      />
    </Tooltip>
  )
}
