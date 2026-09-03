import { Badge, Box, Group, Stack, Text } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { relativeTime as rel } from "../lib/relativeTime"
import { eventLabel } from "../lib/eventMeta"
import { EventDot } from "./EventDot"
import { EventResourceChip } from "./EventResourceChip"
import { ROW_PAD_X } from "./timelineRail"

/**
 * One entry on the timeline rail: a dot on the line, then the event's text.
 *
 * The row is NOT one big button. The details area is a button, and the
 * resource chip beneath it is a second, separate button — nesting one inside
 * the other would be invalid markup and would make a click ambiguous.
 */
export function EventRow({
  e, showWorktrees, onOpen, onSelectResource, resolveResource, onSelectWorktree, canSelectResource,
}: {
  e: TimelineEvent
  showWorktrees?: boolean
  onOpen?: (e: TimelineEvent) => void
  /** Selects the event's resource. Omit where selection has no meaning. */
  onSelectResource?: (key: { type: string; id: string }) => void
  /** Supplies the tracked resource, so the chip's icon shows real status. */
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
  /**
   * Opens one of the worktrees following this event's resource. Supplied on
   * the global timeline, where a worktree badge is the only way to reach the
   * worktree an event belongs to.
   */
  onSelectWorktree?: (path: string) => void
  /**
   * Whether this event's resource can actually be opened. The global timeline
   * routes via the first worktree following the resource, and an event whose
   * resource no longer belongs to any worktree has nowhere to go — better no
   * chip than a button that does nothing.
   */
  canSelectResource?: (e: TimelineEvent) => boolean
}) {
  // Only the dot shows the type now — as its tooltip.
  const label = eventLabel(e.type, e.type_label)

  return (
    <Box style={{ display: "flex", gap: "var(--mantine-spacing-sm)", alignItems: "flex-start", padding: ROW_PAD_X }}>
      <EventDot type={e.type} label={label} />
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Box
          component={onOpen ? "button" : "div"}
          type={onOpen ? "button" : undefined}
          onClick={onOpen ? () => onOpen(e) : undefined}
          data-interactive={onOpen ? "true" : undefined}
          style={{
            width: "100%", textAlign: "left", background: "transparent", border: 0,
            padding: 0, font: "inherit", color: "inherit", borderRadius: "var(--mantine-radius-sm)",
          }}
        >
          <Stack gap={2}>
            <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
              {e.unread && (
                // A mark on the ROW, not on the rail dot: the rail dot already
                // encodes event type, and loading a second, unrelated signal
                // onto it makes both harder to read. Unified timelines
                // interleave resources, so unread events are not contiguous
                // and a divider cannot be drawn here — each one is marked
                // individually instead.
                <span
                  role="img"
                  aria-label="unread event"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "var(--mantine-color-blue-5)",
                    flexShrink: 0,
                  }}
                />
              )}
              <Text size="sm" fw={600} style={{ overflowWrap: "anywhere", minWidth: 0 }}>{e.title}</Text>
              <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                {e.author && `${e.author} · `}{rel(e.external_ts || e.ts)}
              </Text>
            </Group>
            {/* When no chip is shown — no select handler, or nothing to
                select — name the resource here instead, so the event never
                loses all trace of what it belongs to. */}
            {!(onSelectResource && (canSelectResource?.(e) ?? true)) && e.resource_title && (
              <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{e.resource_title}</Text>
            )}
            {e.body && <Text size="xs" c="dimmed" lineClamp={2} style={{ overflowWrap: "anywhere" }}>{e.body}</Text>}
          </Stack>
        </Box>

        {/*
          The chip and the worktree badges live OUTSIDE the details button.
          They are interactive in their own right, and a button nested inside
          a button is invalid markup with an ambiguous click target.
        */}
        <Group gap={6} wrap="wrap">
          {onSelectResource && (canSelectResource?.(e) ?? true) && (
            <EventResourceChip e={e} onSelect={onSelectResource} resolveResource={resolveResource} />
          )}
          {showWorktrees && e.worktrees.map((w, i) => {
            const path = e.worktree_paths?.[i]
            // Only a button when we know where it goes: paths arrive with the
            // event, and an older cached response may not carry them.
            return onSelectWorktree && path ? (
              <Badge
                key={w}
                size="xs"
                variant="outline"
                component="button"
                type="button"
                aria-label={`open worktree ${w}`}
                onClick={() => onSelectWorktree(path)}
                data-interactive="true"
                style={{ cursor: "pointer" }}
              >
                Worktree: {w}
              </Badge>
            ) : (
              <Badge key={w} size="xs" variant="outline">Worktree: {w}</Badge>
            )
          })}
        </Group>
      </Stack>
    </Box>
  )
}
