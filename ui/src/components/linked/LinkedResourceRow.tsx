import { Anchor, Badge, Box, Group, Text } from "@mantine/core"
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
 * One linked resource: [toggle] [icon] [key] [status] [marker], then the
 * title (lined up with the key) and any link context, with the actions
 * beside the whole entry, vertically centred, so the title truncates before
 * them. On a narrow viewport the actions wrap below rather than crushing the
 * text. `toggle` is the tree's chevron (or a spacer of its width).
 */
export function LinkedResourceRow({ item, path, hideFollow, marker, toggle }: {
  item: LinkedItem
  path?: string
  hideFollow?: boolean
  marker?: React.ReactNode
  toggle?: React.ReactNode
}) {
  const status = statusText(item)
  const indent = (toggle ? TOGGLE_W + TOGGLE_GAP : 0) + ICON_SLOT + ICON_GAP
  return (
    <Group py={ROW_PY} className="linked-item" justify="space-between" gap="xs" wrap="wrap" align="center">
      <Box style={{ flex: "1 1 240px", minWidth: 0 }}>
        <Box style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
          {toggle && <Box mr={TOGGLE_GAP} style={{ flexShrink: 0 }}>{toggle}</Box>}
          {/* A fixed-width slot, so every row's text starts at the same x
              whatever the icon's own size. */}
          <Box w={ICON_SLOT} mr={ICON_GAP} style={{ display: "flex", justifyContent: "center", flexShrink: 0 }}>{icon(item)}</Box>
          <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" c="dimmed" truncate="end" style={{ minWidth: 0 }}>{keyText(item)}</Text>
            {status && <Badge size="sm" variant="light" color="gray" style={{ flexShrink: 0 }}>{status}</Badge>}
            {marker}
          </Group>
        </Box>
        {item.resolved ? (
          <Text size="sm" truncate="end" pl={indent}>{titleNode(item)}</Text>
        ) : (
          <Text size="sm" c="dimmed" fs="italic" pl={indent}>couldn't load details</Text>
        )}
        {item.context && <ContextLine item={item} context={item.context} indent={indent} />}
      </Box>
      <LinkedResourceActions item={item} path={path} hideFollow={hideFollow} />
    </Group>
  )
}

/** The tree's chevron (an ActionIcon size="sm") and its gap to the icon. */
export const TOGGLE_W = 22
export const TOGGLE_GAP = 4
const ICON_SLOT = 16
export const ICON_GAP = 10

/** Vertical padding of a row; the tree's fold rows use it too. */
export const ROW_PY = 6

/**
 * The text the link was written in, with the link's own label as a link, so
 * a bare "PROJ-9" row also says why it is there. Indented past the icon.
 */
// The server collapses whitespace around the link, so whether a space
// separated it from its neighbours is lost. Punctuation that hugs a word in
// prose ("the spec, thanks", "(see docs)") is put back against the link
// rather than spaced off from it.
const HUGS_PREVIOUS = /^[.,;:!?)\]}'"’”]/
const HUGS_NEXT = /[([{'"‘“]$/

function ContextLine({ item, context, indent }: { item: LinkedItem; context: NonNullable<LinkedItem["context"]>; indent: number }) {
  const { before, label, after } = context
  return (
    <Text size="xs" c="dimmed" fs="italic" pl={indent} data-testid="link-context">
      {before && <>{before}{HUGS_NEXT.test(before) ? "" : " "}</>}
      <Anchor href={item.url} target="_blank" rel="noreferrer" inherit>{label}</Anchor>
      {after && <>{HUGS_PREVIOUS.test(after) ? "" : " "}{after}</>}
    </Text>
  )
}
