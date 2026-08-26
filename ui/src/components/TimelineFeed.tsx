import { useState } from "react"
import { Alert, Box, Button, Center, Loader, Stack, Text } from "@mantine/core"
import type { TimelineEvent } from "../api/types"
import { EventRow } from "./EventRow"
import { EventDetailsModal } from "./EventDetailsModal"

export function TimelineFeed({ events, loading, error, showWorktrees, hasMore, onLoadMore, loadingMore }: {
  events: TimelineEvent[]; loading: boolean; error: unknown; showWorktrees?: boolean
  /** Omit the three below for a feed that is not paginated. */
  hasMore?: boolean
  onLoadMore?: () => void
  loadingMore?: boolean
}) {
  const [detail, setDetail] = useState<TimelineEvent | null>(null)

  if (loading) return <Loader />
  if (error) return <Alert color="red">{String((error as Error).message || error)}</Alert>
  if (events.length === 0) return <Text c="dimmed" size="sm">No events yet.</Text>

  return (
    <>
      {/*
        The rail is a left border on the container, with each dot painted over
        it — rather than a line segment per row, which would leave gaps at the
        joins and misalign whenever a row's height changed.
      */}
      <Stack
        gap="xs"
        style={{
          borderLeft: "2px solid var(--mantine-color-dark-4)",
          marginLeft: 11, // half the dot's width, so the line runs through it
          paddingLeft: 0,
        }}
      >
        {events.map((e) => (
          <Box key={e.id} style={{ marginLeft: -12 }}>
            <EventRow e={e} showWorktrees={showWorktrees} onOpen={setDetail} />
          </Box>
        ))}
        {hasMore && onLoadMore && (
          // A button rather than scroll-triggered loading: these feeds sit in
          // side-by-side panes that scroll independently, and an infinite
          // scroller in one pane makes the page height jump under the other.
          <Center style={{ marginLeft: -12 }}>
            <Button size="xs" variant="subtle" onClick={onLoadMore} loading={loadingMore}>
              Load more
            </Button>
          </Center>
        )}
      </Stack>
      <EventDetailsModal e={detail} onClose={() => setDetail(null)} />
    </>
  )
}
