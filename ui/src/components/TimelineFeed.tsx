import { useState } from "react"
import { Alert, Box, Button, Center, Loader, Stack, Text } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { EventRow } from "./EventRow"
import { EventDetailsModal } from "./EventDetailsModal"
import { DOT_CENTER, RAIL_WIDTH } from "./timelineRail"

export function TimelineFeed({
  events, loading, error, showWorktrees, hasMore, onLoadMore, loadingMore,
  onSelectResource, resolveResource,
}: {
  events: TimelineEvent[]; loading: boolean; error: unknown; showWorktrees?: boolean
  /** Omit the three below for a feed that is not paginated. */
  hasMore?: boolean
  onLoadMore?: () => void
  loadingMore?: boolean
  /**
   * Selects an event's resource. Omit on feeds where that has no meaning —
   * the home page's global timeline spans worktrees, so there is no single
   * worktree whose selection could change.
   */
  onSelectResource?: (key: { type: string; id: string }) => void
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
}) {
  const [detail, setDetail] = useState<TimelineEvent | null>(null)

  if (loading) return <Loader />
  if (error) return <Alert color="red">{String((error as Error).message || error)}</Alert>
  if (events.length === 0) return <Text c="dimmed" size="sm">No events yet.</Text>

  return (
    <>
      {/*
        The rail is one absolutely-positioned line behind the rows, not a
        border on the container and not a segment per row. A per-row segment
        gaps at the joins; a container border has to be offset by hand against
        the row's padding, which is exactly how it ended up running down the
        dots' left edge instead of through their centres. Positioning it at
        DOT_CENTER — the same constant the rows use to place their dots —
        makes the alignment true by construction.
      */}
      <Box style={{ position: "relative" }}>
        <Box
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: DOT_CENTER - RAIL_WIDTH / 2,
            width: RAIL_WIDTH,
            background: "var(--mantine-color-dark-4)",
          }}
        />
        <Stack gap={2} style={{ position: "relative" }}>
          {events.map((e) => (
            <EventRow
              key={e.id}
              e={e}
              showWorktrees={showWorktrees}
              onOpen={setDetail}
              onSelectResource={onSelectResource}
              resolveResource={resolveResource}
            />
          ))}
          {hasMore && onLoadMore && (
            // A button rather than scroll-triggered loading: these feeds sit
            // in side-by-side panes that scroll independently, and an
            // infinite scroller in one pane makes the other jump.
            <Center>
              <Button size="xs" variant="subtle" onClick={onLoadMore} loading={loadingMore}>
                Load more
              </Button>
            </Center>
          )}
        </Stack>
      </Box>
      <EventDetailsModal
        e={detail}
        onClose={() => setDetail(null)}
        onSelectResource={onSelectResource}
        resolveResource={resolveResource}
      />
    </>
  )
}
