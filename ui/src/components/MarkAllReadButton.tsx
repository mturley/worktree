import { useState } from "react"
import { Alert, Button, Checkbox, Group, Modal, Stack } from "@mantine/core"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"
import { markRead as markThreadRead } from "../api/slackApi"
import { slackTabFromResource } from "./SlackThreadPane"

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** How each resource type is named in the modal, in display order. */
const KINDS = [
  { type: "pr", source: "GitHub", item: ["event", "events"], container: ["PR", "PRs"] },
  { type: "jira", source: "Jira", item: ["event", "events"], container: ["issue", "issues"] },
  { type: "slack", source: "Slack", item: ["message", "messages"], container: ["thread", "threads"] },
] as const

type Kind = (typeof KINDS)[number]["type"]

/** One resource to mark read, and the write that does it. */
interface Target {
  count: number
  mark: () => Promise<unknown>
}

/**
 * The resource as a mark-read target, or null when it has nothing unread or
 * lacks the timestamp to mark it through.
 *
 * Everything is marked through what the user was SHOWN, never "now":
 *   - GitHub/Jira through unread_through_ts — the newest of the events its
 *     unread_count counted, from the same server snapshot.
 *   - Slack through its cached updated_ts — the latest message as of the
 *     poll that flagged it unread. Slack owns the cursor, so this writes to
 *     Slack itself; the server re-polls the thread before answering.
 * Anything newer stays unread, as the per-resource button keeps events that
 * arrive after render. A resource missing its timestamp (an older server, a
 * thread never fully polled) is skipped rather than guessed at.
 */
function toTarget(r: ResourceDTO): Target | null {
  const count = r.unread_count ?? 0
  if (r.type === "slack") {
    const { channel, threadTs } = slackTabFromResource(r)
    if (!r.has_unread || !r.updated_ts || !threadTs) return null
    const latest = r.updated_ts
    // unread_count is at least 1 while has_unread (the server guarantees it);
    // the floor only guards an older cached response that predates it.
    return { count: Math.max(count, 1), mark: () => markThreadRead(channel, threadTs, latest) }
  }
  if (count <= 0 || !r.unread_through_ts) return null
  const through = r.unread_through_ts
  return { count, mark: () => api.markResourceRead({ type: r.type, id: r.id, through_ts: through }) }
}

/**
 * Clears unread activity across a worktree's resources, one checkbox per
 * resource type that has any — "Mark 3 GitHub events as read across 2 PRs" —
 * all checked by default. Only the checked types are marked.
 *
 * Unchecked types are remembered as EXCLUSIONS, not checked ones as
 * inclusions, so a type that gains unreads while the modal is open (a poll
 * landed) arrives checked like the rest. Reopening starts fully checked.
 *
 * The counts are read live from `resources`, so a poll landing while the
 * modal is open updates the numbers and what gets sent together.
 */
export function MarkAllReadButton({ resources }: { resources: ResourceDTO[] }) {
  const [opened, setOpened] = useState(false)
  const [unchecked, setUnchecked] = useState<ReadonlySet<Kind>>(new Set())
  const qc = useQueryClient()

  const groups = KINDS.map((kind) => {
    const targets = resources
      .filter((r) => r.type === kind.type)
      .map(toTarget)
      .filter((t): t is Target => t !== null)
    return { kind, targets, count: targets.reduce((n, t) => n + t.count, 0) }
  }).filter((g) => g.targets.length > 0)
  const selected = groups.filter((g) => !unchecked.has(g.kind.type))

  const markAll = useMutation({
    // Parallel and independent: each call only moves one cursor forward, so a
    // partial failure leaves nothing inconsistent and a retry is safe.
    mutationFn: () => Promise.all(selected.flatMap((g) => g.targets.map((t) => t.mark()))),
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

  if (groups.length === 0 && !opened) return null

  const openModal = () => {
    setUnchecked(new Set())
    markAll.reset()
    setOpened(true)
  }

  const toggle = (type: Kind, checked: boolean) =>
    setUnchecked((prev) => {
      const next = new Set(prev)
      if (checked) next.delete(type)
      else next.add(type)
      return next
    })

  return (
    <>
      {groups.length > 0 && (
        <Button
          size="compact-sm"
          // Same blue treatment as ResourceDetailPane's mark-read button — see
          // there for why it is not the theme's primary, and why `vars`.
          variant="filled"
          color="blue"
          vars={() => ({ root: { "--button-hover": "var(--mantine-color-blue-4)" } })}
          onClick={openModal}
        >
          Mark all read
        </Button>
      )}
      <Modal opened={opened} onClose={() => setOpened(false)} title="Mark all read" centered>
        <Stack gap="sm">
          {groups.map(({ kind, targets, count }) => (
            <Checkbox
              key={kind.type}
              checked={!unchecked.has(kind.type)}
              onChange={(e) => toggle(kind.type, e.currentTarget.checked)}
              label={`Mark ${plural(count, `${kind.source} ${kind.item[0]}`, `${kind.source} ${kind.item[1]}`)}`
                + ` as read across ${plural(targets.length, kind.container[0], kind.container[1])}`}
            />
          ))}
          {markAll.isError && (
            <Alert color="red">{String((markAll.error as Error)?.message || markAll.error)}</Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setOpened(false)}>Cancel</Button>
            <Button
              color="blue"
              loading={markAll.isPending}
              disabled={selected.length === 0}
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
