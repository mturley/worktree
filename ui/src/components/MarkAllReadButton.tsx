import { useState } from "react"
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Clears every unread GitHub/Jira event across a worktree's resources, after
 * a confirmation naming how many events and resources that is.
 *
 * Slack threads are deliberately out of scope: Slack owns their read state,
 * the server refuses to write it (unread.ErrSlackNotSupported), and they are
 * cleared from their thread view. The modal says so when one is unread, so the
 * Slack dot surviving the click is not a surprise.
 *
 * Each resource is marked through its OWN unread_through_ts — the newest of
 * the events its unread_count counted, from the same server snapshot — never
 * "now". Events that land after that snapshot stay unread, exactly as the
 * per-resource button keeps events that arrive after render. A resource
 * without one (an older server) is skipped rather than guessed at.
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
  const slackUnread = resources.some((r) => r.type === "slack" && r.has_unread)

  const markAll = useMutation({
    // Parallel and independent: each call only moves one cursor forward, so a
    // partial failure leaves nothing inconsistent and a retry is safe.
    mutationFn: () =>
      Promise.all(targets.map((r) =>
        api.markResourceRead({ type: r.type, id: r.id, through_ts: r.unread_through_ts! }))),
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

  if (targets.length === 0 && !opened) return null

  const close = () => {
    setOpened(false)
    markAll.reset()
  }

  return (
    <>
      {targets.length > 0 && (
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
          <Text>
            {`Mark ${plural(events, "event", "events")} read across ${plural(targets.length, "resource", "resources")}?`}
          </Text>
          {slackUnread && (
            <Text size="sm" c="dimmed">
              Slack threads are not affected. Mark them read from their thread view.
            </Text>
          )}
          {markAll.isError && (
            <Alert color="red">{String((markAll.error as Error)?.message || markAll.error)}</Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={close}>Cancel</Button>
            <Button
              color="blue"
              loading={markAll.isPending}
              disabled={targets.length === 0}
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
