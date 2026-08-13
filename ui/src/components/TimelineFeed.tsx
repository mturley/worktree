import { Alert, Loader, Stack, Text } from "@mantine/core"
import type { TimelineEvent } from "../api/types"
import { EventRow } from "./EventRow"

export function TimelineFeed({ events, loading, error, showWorktrees }: {
  events: TimelineEvent[]; loading: boolean; error: unknown; showWorktrees?: boolean
}) {
  if (loading) return <Loader />
  if (error) return <Alert color="red">{String((error as Error).message || error)}</Alert>
  if (events.length === 0) return <Text c="dimmed" size="sm">No events yet.</Text>
  return <Stack gap="xs">{events.map((e) => <EventRow key={e.id} e={e} showWorktrees={showWorktrees} />)}</Stack>
}
