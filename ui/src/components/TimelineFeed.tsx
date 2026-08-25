import { Alert, Button, Center, Loader, Stack, Text } from "@mantine/core"
import type { TimelineEvent } from "../api/types"
import { EventRow } from "./EventRow"

export function TimelineFeed({ events, loading, error, showWorktrees, hasMore, onLoadMore, loadingMore }: {
  events: TimelineEvent[]; loading: boolean; error: unknown; showWorktrees?: boolean
  /** Omit the three below for a feed that is not paginated. */
  hasMore?: boolean
  onLoadMore?: () => void
  loadingMore?: boolean
}) {
  if (loading) return <Loader />
  if (error) return <Alert color="red">{String((error as Error).message || error)}</Alert>
  if (events.length === 0) return <Text c="dimmed" size="sm">No events yet.</Text>
  return (
    <Stack gap="xs">
      {events.map((e) => <EventRow key={e.id} e={e} showWorktrees={showWorktrees} />)}
      {hasMore && onLoadMore && (
        // A button rather than scroll-triggered loading: these feeds sit in
        // side-by-side panes that scroll independently, and an infinite
        // scroller in one pane makes the page height jump under the other.
        <Center>
          <Button size="xs" variant="subtle" onClick={onLoadMore} loading={loadingMore}>
            Load more
          </Button>
        </Center>
      )}
    </Stack>
  )
}
