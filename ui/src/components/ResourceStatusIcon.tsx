import {
  IconCircleDashed,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconBrandSlack,
  IconTicket,
} from "@tabler/icons-react"
import { Group, Text } from "@mantine/core"
import { useState } from "react"
import type { ResourceDTO } from "../api/types"

/**
 * Jira's icon URLs sit behind the same Basic auth as its REST API, so a
 * browser cannot fetch them directly — they go through our server-side
 * proxy, which re-attaches the credentials.
 */
export function jiraIconProxy(url: string): string {
  return `/api/jira-icon?url=${encodeURIComponent(url)}`
}

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
    return { Icon: IconBrandSlack, color: "grape", label: "slack thread" }
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
  const [iconFailed, setIconFailed] = useState(false)

  // Jira serves a distinct icon per issue type (Bug, Story, Epic, Spike…),
  // which says more at a glance than one generic ticket glyph. If the fetch
  // fails — unconfigured credentials, a revoked token, an offline Jira — fall
  // through to the tabler icon below rather than leaving a broken image.
  if (r.type === "jira" && r.issue_type_icon_url && !iconFailed) {
    const alt = r.issue_type ? `${r.issue_type} — ${label}` : label
    return (
      <img
        src={jiraIconProxy(r.issue_type_icon_url)}
        alt={alt}
        title={alt}
        width={size}
        height={size}
        onError={() => setIconFailed(true)}
        style={{ flexShrink: 0, display: "block" }}
      />
    )
  }

  return (
    <Icon
      size={size}
      aria-label={label}
      role="img"
      style={{ color: `var(--mantine-color-${color}-6)`, flexShrink: 0 }}
    />
  )
}

/**
 * A resource's status icon paired with its title.
 *
 * The icon mapping lives in this file (resourceStatusMeta) and every surface
 * that shows a resource icon reads it from here — the worktree card's focus
 * lines and the resource cards' titles alike — so changing which icon a
 * status uses changes it everywhere at once.
 */
/**
 * Unread marker for a Slack thread, from the poller-cached has_unread.
 *
 * Rendered here rather than in the Slack card so it appears wherever a
 * resource title does — the worktree card's focus lines included — and so
 * there is one place to change how "unread" looks.
 */
function UnreadDot() {
  return (
    <span
      role="img"
      aria-label="unread"
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: "var(--mantine-color-blue-5)",
        flexShrink: 0,
      }}
    />
  )
}

export function ResourceTitle({
  r,
  label,
  fw = 600,
  size = "sm",
}: {
  r: ResourceDTO
  /** Defaults to the resource's own title, falling back to its id. */
  label?: string
  fw?: number
  size?: string
}) {
  return (
    <Group gap={6} wrap="nowrap" align="center">
      {r.has_unread && <UnreadDot />}
      <ResourceStatusIcon r={r} />
      <Text size={size} fw={fw} style={{ overflowWrap: "anywhere" }}>
        {label ?? r.title ?? r.id}
      </Text>
    </Group>
  )
}
