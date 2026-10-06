import { Badge, Group, Loader, Text } from "@mantine/core"
import { IconMessage, IconWorld } from "@tabler/icons-react"
import type { ResourceDTO } from "../api/types"
import { shortResourceRef } from "../lib/resourceRef"
import { LinkFavicon, ResourceStatusIcon } from "./ResourceStatusIcon"
import { SlackMark } from "./icons/SlackMark"
import { JiraMark } from "./icons/JiraMark"
import { GitHubMark } from "./icons/GitHubMark"

/**
 * Each resource type's name, brand icon and badge colour.
 *
 * The icons are the same marks the activity feed's source toggles use, so a
 * type looks the same on a card as on the toggle that filters to it. A link
 * has no brand, so the globe stands in for one.
 */
const RESOURCE_TYPES: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  pr: { label: "GitHub", color: "violet", icon: <GitHubMark size={14} aria-hidden /> },
  jira: { label: "Jira", color: "blue", icon: <JiraMark size={14} aria-hidden /> },
  slack: { label: "Slack", color: "grape", icon: <SlackMark size={14} aria-hidden /> },
  link: { label: "Link", color: "teal", icon: <IconWorld size={14} aria-hidden style={{ flexShrink: 0 }} /> },
}

/**
 * Whether the poller has fetched anything about this resource yet. Until it
 * has, a PR or issue is just an id, and its card says so with a spinner.
 */
export function isEnriched(r: ResourceDTO): boolean {
  return Boolean(
    r.title || r.state || r.review_decision || r.ci_status || r.new_commits_since_review || r.author ||
    r.status || r.priority || r.issue_type || r.assignee || (r.labels && r.labels.length > 0) || r.updated_at
  )
}

/**
 * Whether this resource is still waiting on its first fetch. Slack threads
 * and links never are: a thread is usable from its id alone, and a link is
 * resolved once when added and never polled, so a spinner on it would never
 * stop.
 */
export function awaitsFetch(r: ResourceDTO): boolean {
  return r.type !== "slack" && r.type !== "link" && !isEnriched(r)
}

/**
 * This resource's own icon: its status (PR state, Jira issue type), a link's
 * favicon, or a spinner until it is fetched. A Slack thread gets a speech
 * bubble — its status icon is the Slack mark, which already leads the line —
 * the same glyph the activity feed uses for its replies. A link without a
 * favicon has none, as its fallback globe already leads the line.
 */
function resourceIcon(r: ResourceDTO): React.ReactNode {
  if (r.type === "slack") {
    return (
      <IconMessage
        size={14}
        aria-label="slack thread"
        role="img"
        style={{ color: "var(--mantine-color-grape-6)", flexShrink: 0 }}
      />
    )
  }
  if (r.type === "link") return <LinkFavicon r={r} />
  if (awaitsFetch(r)) return <Loader size={12} aria-label="loading" role="status" />
  return <ResourceStatusIcon r={r} />
}

/**
 * This resource's key: a PR number, an issue key (with its type, since Jira's
 * issue-type icons are small and not all obvious), a link's domain, a
 * thread's channel. Where the title can't identify a resource, this can.
 */
function resourceKey(r: ResourceDTO): string {
  switch (r.type) {
    case "pr":
      // "PR" restored to the number, which would otherwise be a bare "#1234".
      return `PR ${shortResourceRef("pr", r.id)}`
    case "jira":
      return r.issue_type ? `${r.issue_type} ${r.id}` : r.id
    case "slack":
      return r.channel_name ? `Thread in #${r.channel_name}` : "Thread"
    case "link":
      return shortResourceRef("link", r.id)
    default:
      return r.id
  }
}

/**
 * A resource's first line, everywhere one is listed: the type's brand icon
 * and badge, then this resource's own icon and key. The brand icon is
 * decorative; the badge beside it names the type.
 *
 * Shared by the worktree page's resource cards and the home page's worktree
 * cards so a resource is introduced the same way on both.
 */
export function ResourceTypeLine({ r, trailing }: { r: ResourceDTO; trailing?: React.ReactNode }) {
  const t = RESOURCE_TYPES[r.type]
  return (
    <Group gap={6} wrap="wrap" align="center" data-resource-type-line>
      {t?.icon}
      {/* The extra margin separates the TYPE (icon + badge) from what
          follows, which is about this resource in particular. */}
      <Badge size="xs" variant="light" color={t?.color} mr={6}>{t?.label ?? r.type}</Badge>
      {resourceIcon(r)}
      <Text size="xs" c="dimmed">{resourceKey(r)}</Text>
      {trailing}
    </Group>
  )
}
