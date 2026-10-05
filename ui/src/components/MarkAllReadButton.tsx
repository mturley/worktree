import { useState } from "react"
import { Alert, Button, Checkbox, Group, Modal, Stack, Text } from "@mantine/core"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"
import { markRead as markThreadRead } from "../api/slackApi"
import { slackTabFromResource } from "./SlackThreadPane"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Clears every unread GitHub/Jira event across a worktree's resources, after
 * a confirmation naming how many events and resources that is — and, only if
 * the user ticks the box, its unread Slack threads too.
 *
 * Slack is opt-in, and unchecked by default, because it is a different kind
 * of write: Slack owns those threads' read state, so marking one read here
 * marks it read in Slack itself, everywhere the user reads Slack. With only
 * Slack threads unread there is nothing else to do, so the threads are the
 * question and there is no box.
 *
 * Everything is marked through what the user was SHOWN, never "now". Each
 * GitHub/Jira resource goes through its own unread_through_ts — the newest of
 * the events its unread_count counted, from the same server snapshot — and
 * each Slack thread through its cached updated_ts, the latest message as of
 * the poll that flagged it unread. Anything newer stays unread, exactly as
 * the per-resource button keeps events that arrive after render. A resource
 * missing its timestamp (an older server, a thread never fully polled) is
 * skipped rather than guessed at.
 *
 * The counts are read live from `resources`, so a poll landing while the
 * modal is open updates the numbers and what gets sent together.
 */
export function MarkAllReadButton({ resources }: { resources: ResourceDTO[] }) {
  const [opened, setOpened] = useState(false)
  const qc = useQueryClient()

  const targets = resources.filter(
    (r) => r.type !== "slack" && (r.unread_count ?? 0) > 0 && !!r.unread_through_ts,
  )
  const events = targets.reduce((n, r) => n + (r.unread_count ?? 0), 0)
  const threads = resources
    .filter((r) => r.type === "slack" && r.has_unread && !!r.updated_ts)
    .map((r) => ({ ...slackTabFromResource(r), latest: r.updated_ts! }))
    .filter((t) => !!t.threadTs)
  const slackOnly = targets.length === 0 && threads.length > 0
  const [includeSlack, setIncludeSlack] = useState(false)
  const markSlack = slackOnly || includeSlack

  const markAll = useMutation({
    // Parallel and independent: each call only moves one cursor forward, so a
    // partial failure leaves nothing inconsistent and a retry is safe.
    mutationFn: () =>
      Promise.all([
        ...targets.map((r) =>
          api.markResourceRead({ type: r.type, id: r.id, through_ts: r.unread_through_ts! })),
        // The server re-polls each thread after Slack accepts the mark, so
        // the invalidation below finds its cached state already fresh.
        ...(markSlack ? threads.map((t) => markThreadRead(t.channel, t.threadTs, t.latest)) : []),
      ]),
    onSuccess: () => setOpened(false),
    // Settled, not success: a partial failure still moved some cursors, and
    // the surfaces showing them must catch up either way. Same three as the
    // per-resource button in ResourceDetailPane.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["worktrees"] })
      void qc.invalidateQueries({ queryKey: ["resources"] })
      void qc.invalidateQueries({ queryKey: ["timeline"] })
    },
  })

  if (targets.length === 0 && threads.length === 0 && !opened) return null

  const close = () => {
    setOpened(false)
    setIncludeSlack(false)
    markAll.reset()
  }

  const question = slackOnly
    ? `Mark ${plural(threads.length, "Slack thread", "Slack threads")} read?`
    : `Mark ${plural(events, "event", "events")} read across ${plural(targets.length, "resource", "resources")}?`

  return (
    <>
      {(targets.length > 0 || threads.length > 0) && (
        <Button
          size="compact-sm"
          // Same blue treatment as ResourceDetailPane's mark-read button — see
          // there for why it is not the theme's primary, and why `vars`.
          variant="filled"
          color="blue"
          vars={() => ({ root: { "--button-hover": "var(--mantine-color-blue-4)" } })}
          onClick={() => setOpened(true)}
        >
          Mark all read
        </Button>
      )}
      <Modal opened={opened} onClose={close} title="Mark all read" centered>
        <Stack gap="sm">
          <Text>{question}</Text>
          {!slackOnly && threads.length > 0 && (
            <Checkbox
              checked={includeSlack}
              onChange={(e) => setIncludeSlack(e.currentTarget.checked)}
              label={`Also mark ${plural(threads.length, "Slack thread", "Slack threads")} as read`}
            />
          )}
          {markAll.isError && (
            <Alert color="red">{String((markAll.error as Error)?.message || markAll.error)}</Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={close}>Cancel</Button>
            <Button
              color="blue"
              loading={markAll.isPending}
              disabled={targets.length === 0 && threads.length === 0}
              onClick={() => markAll.mutate()}
            >
              Mark read
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  )
}
