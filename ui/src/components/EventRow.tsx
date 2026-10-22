import { useState } from "react"
import { useMediaQuery } from "@mantine/hooks"
import { Badge, Box, Button, Group, Stack, Text, Tooltip } from "@mantine/core"
import { IconArchive } from "@tabler/icons-react"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { relativeTime as rel } from "../lib/relativeTime"
import { eventLabel } from "../lib/eventMeta"
import { EventDot } from "./EventDot"
import { EventResourceChip } from "./EventResourceChip"
import { UnreadMarkerDot } from "./UnreadMarkerDot"
import { READ_BOX_BORDER, UNREAD_BG, UNREAD_BOX_BORDER } from "../lib/unread"
import { ROW_PAD_X } from "./timelineRail"
import { isArchivedEvent } from "../lib/openEvent"
import { MatchWhy } from "./search/MatchWhy"
import { SearchHighlight } from "./search/SearchHighlight"
import { useCrossHover } from "./CrossHoverContext"
import { eventTaskKey } from "../lib/taskEventKey"

/**
 * One entry on the timeline rail: a dot on the line, then the event's text.
 *
 * The WHOLE row is one button. Everything inside it — the resource chip, the
 * worktree badges — is read-only text, which is what makes that possible: a
 * button nested inside a button is invalid markup with an ambiguous click
 * target, so the row can only be a single surface if nothing inside it is
 * interactive too.
 *
 * The one exception is the opt-in "＋ task" hover action (`onMakeTask`),
 * which is therefore NOT inside the row: the row and the action are
 * siblings in a positioned wrapper, the action floating over the row's
 * top-right corner, so its click never reaches the row.
 */
export function EventRow({
  e, showWorktrees, showResource = true, onOpen, onSelectResource, resolveResource, canSelectResource,
  unreadBorder = true, onMakeTask,
}: {
  e: TimelineEvent
  showWorktrees?: boolean
  /**
   * Whether an unread row draws its blue border. False in the search
   * dropdown, whose own highlight is a blue outline: there the background
   * and dot say unread, and two blue boxes would read as one.
   */
  unreadBorder?: boolean
  /**
   * Names the resource this event belongs to. False on a feed already
   * filtered to ONE resource, where every row would repeat the same line.
   */
  showResource?: boolean
  /** Opens the details modal — where the row has no resource to go to. */
  onOpen?: (e: TimelineEvent) => void
  /**
   * Selects the event's resource. Omit where selection has no meaning. The
   * event itself comes along for callers that want more than the resource —
   * the home page opens its details once it lands on the worktree.
   */
  onSelectResource?: (key: { type: string; id: string }, e: TimelineEvent) => void
  /** Supplies the tracked resource, so the chip's icon shows real status. */
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
  /**
   * Whether this event's resource can actually be opened. The global timeline
   * routes via the first worktree following the resource, and an event whose
   * resource no longer belongs to any worktree has nowhere to go — that row
   * falls back to opening its details instead.
   */
  canSelectResource?: (e: TimelineEvent) => boolean
  /**
   * Offers "＋ task" on hover: makes a task from this event. Opt-in per feed,
   * and shown only on watcher events (a task's own events can't be linked).
   */
  onMakeTask?: (e: TimelineEvent) => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  // A touch screen has no hover to reveal "＋ task", so there it always shows.
  const noHover = useMediaQuery("(hover: none)")
  const actionShown = hovered || focused || noHover
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
    ? () => onSelectResource?.(resourceKey, e)
    : onOpen
      ? () => onOpen(e)
      : undefined
  const tip = resourceKey ? "View event details in worktree" : "View event details"

  // Only a row that goes to its resource takes part in cross-hover: one that
  // opens its details (archived, resourceless, or in a pane already showing
  // the resource) has no worktree or resource card to point at.
  const crossHover = useCrossHover(resourceKey
    ? { kind: "event", type: resourceKey.type, id: resourceKey.id, paths: e.worktree_paths ?? [] }
    : null)

  /*
   * CI events carry their whole check list as the body — dozens of lines of
   * "✓ Unit-Tests". Clamped to two, that is a meaningless fragment beside a
   * title that already summarises it ("CI failed … (2 failed, 35 passed)").
   * The details modal still shows the list in full.
   */
  const showBody = !!e.body && !e.type.startsWith("ci_")
  const bodyMatch = e.match?.field === "body" && showBody

  // Only on the global feed: nothing follows this resource any more, which
  // is why the row opens details. The title steps back behind a badge
  // saying so.
  const archived = !!showWorktrees && isArchivedEvent(e)

  const row = (
    <Box
      component={activate ? "button" : "div"}
      type={activate ? "button" : undefined}
      onClick={activate}
      data-event-row="true"
      data-unread={e.unread ? "true" : undefined}
      data-clickable={activate ? "true" : undefined}
      {...crossHover}
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
        border: e.unread && unreadBorder ? UNREAD_BOX_BORDER : READ_BOX_BORDER,
        borderRadius: "var(--mantine-radius-sm)",
        background: e.unread ? UNREAD_BG : "transparent",
      }}
    >
      <EventDot type={e.type} label={label} dimmed={archived} />
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
            {archived && (
              <Badge size="xs" color="gray" variant="light" leftSection={<IconArchive size={10} />} style={{ flex: "none" }}>
                Archived
              </Badge>
            )}
            <Text size="sm" fw={600} c={archived ? "dimmed" : undefined} style={{ overflowWrap: "anywhere", minWidth: 0 }}>
              <SearchHighlight text={e.title} />
            </Text>
            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {e.author && `${e.author} · `}{rel(e.external_ts || e.ts)}
            </Text>
          </Group>
          {/* A resource match is not explained here: the server's snippet is the
              raw resource id, and the chip below names the resource with the
              term marked. */}
          <MatchWhy match={bodyMatch || e.match?.field === "resource" ? null : e.match} />
          {/*
            Above the body, not below it: this names what you are looking at,
            and a two-line quote of a comment is no place to learn it. Absent
            entirely on a single-resource feed, where it is the same line on
            every row.
          */}
          {showResource && (e.resource_type && e.resource_id ? (
            <EventResourceChip e={e} resolveResource={resolveResource} />
          ) : (
            e.resource_title && (
              <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{e.resource_title}</Text>
            )
          ))}
          {showBody && (
            <Text size="xs" c="dimmed" lineClamp={2} style={{ overflowWrap: "anywhere" }}>
              {/* The snippet is centred on the hit, which the clamped first
                  lines of the body may not contain. */}
              <SearchHighlight text={e.match?.field === "body" ? e.match.snippet : e.body ?? ""} />
            </Text>
          )}
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
   * over it whenever you are reading the row at all.
   *
   * Above and left-aligned, not beside: a row is as wide as the feed, and on
   * the pages where the feed is full width there is no margin to the left of
   * it for a tooltip to occupy — it ran off the page. Above costs it the row
   * above's text, which is the lesser of the two.
   */
  const surface = activate ? <Tooltip label={tip} position="top-start">{row}</Tooltip> : row
  if (!onMakeTask || !eventTaskKey(e)) return surface

  return (
    <Box
      style={{ position: "relative" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {surface}
      <Tooltip label="Make a task from this event" position="top-end">
        <Button
          size="compact-xs"
          variant="default"
          aria-label="Make task from this event"
          onClick={() => onMakeTask(e)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            // Shown on hover, and to the keyboard when tabbed to. While
            // hidden it takes no taps or clicks (focus still reaches it).
            opacity: actionShown ? 1 : 0,
            pointerEvents: actionShown ? "auto" : "none",
            transition: "opacity 100ms ease",
          }}
        >
          ＋ task
        </Button>
      </Tooltip>
    </Box>
  )
}
