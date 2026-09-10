import { Badge, Box, Group, Stack, Text, Tooltip } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { relativeTime as rel } from "../lib/relativeTime"
import { eventLabel } from "../lib/eventMeta"
import { EventDot } from "./EventDot"
import { EventResourceChip } from "./EventResourceChip"
import { UnreadMarkerDot } from "./UnreadMarkerDot"
import { READ_BOX_BORDER, UNREAD_BG, UNREAD_BOX_BORDER } from "../lib/unread"
import { ROW_PAD_X } from "./timelineRail"

/**
 * One entry on the timeline rail: a dot on the line, then the event's text.
 *
 * The WHOLE row is one button. Everything inside it — the resource chip, the
 * worktree badges — is read-only text, which is what makes that possible: a
 * button nested inside a button is invalid markup with an ambiguous click
 * target, so the row can only be a single surface if nothing inside it is
 * interactive too.
 */
export function EventRow({
  e, showWorktrees, onOpen, onSelectResource, resolveResource, canSelectResource,
}: {
  e: TimelineEvent
  showWorktrees?: boolean
  /** Opens the details modal — where the row has no resource to go to. */
  onOpen?: (e: TimelineEvent) => void
  /** Selects the event's resource. Omit where selection has no meaning. */
  onSelectResource?: (key: { type: string; id: string }) => void
  /** Supplies the tracked resource, so the chip's icon shows real status. */
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
  /**
   * Whether this event's resource can actually be opened. The global timeline
   * routes via the first worktree following the resource, and an event whose
   * resource no longer belongs to any worktree has nowhere to go — that row
   * falls back to opening its details instead.
   */
  canSelectResource?: (e: TimelineEvent) => boolean
}) {
  // Only the dot shows the type now — as its tooltip.
  const label = eventLabel(e.type, e.type_label)

  /*
   * Where a click on this row goes. Selecting the resource wins wherever it
   * is possible, and the details modal is the fallback — which is exactly the
   * split the three feeds need without any of them saying so: the home page
   * and the worktree page both supply onSelectResource, while the pane that
   * ALREADY has the resource selected supplies none, so its rows open details.
   */
  const resourceKey = onSelectResource && e.resource_type && e.resource_id
    && (canSelectResource?.(e) ?? true)
    ? { type: e.resource_type, id: e.resource_id }
    : null
  const activate = resourceKey
    ? () => onSelectResource?.(resourceKey)
    : onOpen
      ? () => onOpen(e)
      : undefined
  const tip = resourceKey ? "View resource in worktree" : "View event details"

  /*
   * CI events carry their whole check list as the body — dozens of lines of
   * "✓ Unit-Tests". Clamped to two, that is a meaningless fragment beside a
   * title that already summarises it ("CI failed … (2 failed, 35 passed)").
   * The details modal still shows the list in full.
   */
  const showBody = !!e.body && !e.type.startsWith("ci_")

  const row = (
    <Box
      component={activate ? "button" : "div"}
      type={activate ? "button" : undefined}
      onClick={activate}
      data-event-row="true"
      data-unread={e.unread ? "true" : undefined}
      data-clickable={activate ? "true" : undefined}
      style={{
        display: "flex",
        gap: "var(--mantine-spacing-sm)",
        alignItems: "flex-start",
        padding: ROW_PAD_X,
        width: "100%",
        textAlign: "left",
        font: "inherit",
        color: "inherit",
        // ONE border property in both states, never a shorthand plus a
        // conditional borderColor — see UNREAD_BOX_BORDER for the white box
        // that mistake left behind on mark-read. Same reasoning for
        // background: one complete value per state, so the button's default
        // buttonface never shows through on a read row.
        border: e.unread ? UNREAD_BOX_BORDER : READ_BOX_BORDER,
        borderRadius: "var(--mantine-radius-sm)",
        background: e.unread ? UNREAD_BG : "transparent",
      }}
    >
      <EventDot type={e.type} label={label} />
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Stack gap={2}>
          <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
            {e.unread && (
              // A mark on the ROW, not on the rail dot: the rail dot already
              // encodes event type, and loading a second, unrelated signal
              // onto it makes both harder to read. Unified timelines
              // interleave resources, so unread events are not contiguous
              // and a divider cannot be drawn here — each one is marked
              // individually instead.
              <UnreadMarkerDot label="unread event" />
            )}
            <Text size="sm" fw={600} style={{ overflowWrap: "anywhere", minWidth: 0 }}>{e.title}</Text>
            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {e.author && `${e.author} · `}{rel(e.external_ts || e.ts)}
            </Text>
          </Group>
          {/*
            Above the body, not below it: this names what you are looking at,
            and a two-line quote of a comment is no place to learn it.
          */}
          {e.resource_type && e.resource_id ? (
            <EventResourceChip e={e} resolveResource={resolveResource} />
          ) : (
            e.resource_title && (
              <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{e.resource_title}</Text>
            )
          )}
          {showBody && <Text size="xs" c="dimmed" lineClamp={2} style={{ overflowWrap: "anywhere" }}>{e.body}</Text>}
        </Stack>

        {/*
          The worktrees following this event, on a line of their own: on the
          global timeline a resource title can be long enough that a badge
          trailing it lands anywhere, and the worktree is what you scan the
          feed by.
        */}
        {showWorktrees && e.worktrees.length > 0 && (
          <Group gap={6} wrap="wrap">
            {e.worktrees.map((w) => (
              // Light blue, matching the WORKTREE badge on the worktree
              // cards, so the same thing looks the same wherever it is named.
              <Badge key={w} size="xs" color="blue" variant="light">Worktree: {w}</Badge>
            ))}
          </Group>
        )}
      </Stack>
    </Box>
  )

  /*
   * The tooltip names the destination, which differs per row — and there is
   * nothing to explain on a row that does not respond to clicks.
   *
   * No open delay: the whole row is the target, so the pointer is already
   * over it whenever you are reading the row at all. To the left, because
   * a row spans the feed's full width — centred above or below, the tooltip
   * lands on top of the neighbouring row's text, which is the text you were
   * reading when you moved the pointer here.
   */
  return activate ? <Tooltip label={tip} position="left">{row}</Tooltip> : row
}
