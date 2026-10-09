import { Badge, Group, Text } from "@mantine/core"
import { IconMessage, IconWorld } from "@tabler/icons-react"
import type { LinkedItem, ResourceDTO } from "../../api/types"
import { Mrkdwn } from "../../lib/mrkdwn"
import { LinkFavicon, ResourceStatusIcon } from "../ResourceStatusIcon"
import { LinkedResourceActions } from "./LinkedResourceActions"

/** A ResourceDTO-shaped view of an item, so the shared status icon applies. */
export function asResource(item: LinkedItem): ResourceDTO {
  return {
    type: item.type, id: item.id, url: item.url, primary: false,
    title: item.title, state: item.state, status: item.status, issue_type: item.issue_type,
    issue_type_icon_url: item.issue_type_icon_url, channel_name: item.channel_name, favicon: item.favicon,
  }
}

function keyText(item: LinkedItem): string {
  switch (item.type) {
    case "pr": return item.id
    case "jira": return item.issue_type ? `${item.issue_type} ${item.id}` : item.id
    case "slack": return item.channel_name ? `Thread in #${item.channel_name}` : "Slack thread"
    default: return item.domain ?? ""
  }
}

// Excerpts are inline mrkdwn; no user/emoji directories are available here,
// so mentions and custom emoji fall back to their raw tokens.
const NO_USERS = {}
const NO_EMOJI = {}

function titleNode(item: LinkedItem): React.ReactNode {
  if (item.type === "slack") return <Mrkdwn text={item.excerpt ?? ""} users={NO_USERS} emoji={NO_EMOJI} />
  return titleText(item)
}

function titleText(item: LinkedItem): string {
  return item.title || (item.type === "link" ? item.url : "")
}

function statusText(item: LinkedItem): string | undefined {
  if (item.type === "jira") return item.status
  if (item.type === "pr" && item.state) return item.is_draft && item.state === "OPEN" ? "draft" : item.state.toLowerCase()
  return undefined
}

function icon(item: LinkedItem) {
  if (item.type === "slack") {
    return <IconMessage size={14} aria-hidden style={{ color: "var(--mantine-color-grape-6)", flexShrink: 0 }} />
  }
  if (item.type === "link") return <LinkFavicon r={asResource(item)} fallback={<IconWorld size={16} aria-label="link" style={{ flexShrink: 0 }} />} />
  return <ResourceStatusIcon r={asResource(item)} />
}

/**
 * One linked resource: [icon] [key] title [status] [actions]. Wraps so the
 * actions drop below the text on narrow viewports rather than crushing it.
 */
export function LinkedResourceRow({ item, path, hideFollow, marker }: {
  item: LinkedItem
  path?: string
  hideFollow?: boolean
  marker?: React.ReactNode
}) {
  const status = statusText(item)
  return (
    <Group justify="space-between" gap="xs" wrap="wrap" py={4}>
      <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        {icon(item)}
        <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>{keyText(item)}</Text>
        {item.resolved ? (
          <Text size="sm" truncate="end" style={{ minWidth: 0 }}>{titleNode(item)}</Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic">couldn't load details</Text>
        )}
        {status && <Badge size="sm" variant="light" color="gray" style={{ flexShrink: 0 }}>{status}</Badge>}
        {marker}
      </Group>
      <LinkedResourceActions item={item} path={path} hideFollow={hideFollow} />
    </Group>
  )
}
