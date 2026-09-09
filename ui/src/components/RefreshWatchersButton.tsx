import { ActionIcon, Tooltip } from "@mantine/core"
import { IconRefresh } from "@tabler/icons-react"
import { usePollWatchers, useWatchers } from "../hooks/useWatchers"

/**
 * Fetches all three watchers on demand.
 *
 * Spins whenever ANY poll is running — including the background loop's own,
 * not just one the user asked for. That is the honest reading of "is anything
 * fetching right now", and it means the icon starts moving on its own every
 * few minutes, which is the point: you can tell the difference between a
 * quiet feed and a stalled one.
 *
 * Disabled while spinning. The server would no-op a second request anyway
 * (safePollAll's guard), so this is about not offering an action that does
 * nothing rather than about protecting the server.
 */
export function RefreshWatchersButton() {
  const { data } = useWatchers()
  const poll = usePollWatchers()
  // The mutation settling means "the poll was accepted", not "the poll
  // finished" — the server returns immediately. So isPending only covers the
  // gap before the first status refetch reports polling, and the flag carries
  // it from there.
  const busy = !!data?.polling || poll.isPending

  return (
    <Tooltip label={busy ? "Refreshing…" : "Refresh all watchers"}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label="Refresh watchers"
        aria-busy={busy}
        disabled={busy}
        onClick={() => poll.mutate()}
      >
        <IconRefresh
          size={16}
          style={{
            animation: busy ? "wt-spin 900ms linear infinite" : undefined,
          }}
        />
      </ActionIcon>
    </Tooltip>
  )
}
