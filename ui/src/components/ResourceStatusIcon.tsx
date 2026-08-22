import {
  IconCircleDashed,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconMessage,
  IconTicket,
} from "@tabler/icons-react"
import type { ResourceDTO } from "../api/types"

type IconComponent = typeof IconGitPullRequest

interface StatusMeta {
  Icon: IconComponent
  color: string
  label: string
}

/**
 * Single mapping from a resource's cached state to an icon + colour, so the
 * worktree card, the resource list, and the detail pane can never disagree
 * about what "open" or "merged" looks like.
 */
export function resourceStatusMeta(r: ResourceDTO): StatusMeta {
  if (r.type === "slack") {
    return { Icon: IconMessage, color: "grape", label: "slack thread" }
  }
  if (r.type === "pr") {
    switch ((r.state || "").toUpperCase()) {
      case "OPEN": return { Icon: IconGitPullRequest, color: "green", label: "open" }
      case "MERGED": return { Icon: IconGitMerge, color: "violet", label: "merged" }
      case "CLOSED": return { Icon: IconGitPullRequestClosed, color: "red", label: "closed" }
    }
    return { Icon: IconCircleDashed, color: "gray", label: "unknown state" }
  }
  if (r.type === "jira") {
    const status = r.status || ""
    if (!status) return { Icon: IconCircleDashed, color: "gray", label: "unknown state" }
    if (/done|closed|resolved/i.test(status)) return { Icon: IconTicket, color: "green", label: status }
    if (/progress|review/i.test(status)) return { Icon: IconTicket, color: "blue", label: status }
    return { Icon: IconTicket, color: "gray", label: status }
  }
  return { Icon: IconCircleDashed, color: "gray", label: "unknown state" }
}

export function ResourceStatusIcon({ r, size = 14 }: { r: ResourceDTO; size?: number }) {
  const { Icon, color, label } = resourceStatusMeta(r)
  return (
    <Icon
      size={size}
      aria-label={label}
      role="img"
      style={{ color: `var(--mantine-color-${color}-6)`, flexShrink: 0 }}
    />
  )
}
