import { Alert, Badge, Button, Divider, Group, Modal, Stack, Text } from "@mantine/core"
import { IconArchive } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { api } from "../api/client"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { eventLabel } from "../lib/eventMeta"
import { relativeTime as rel } from "../lib/relativeTime"
import { EventDot } from "./EventDot"
import { EventResourceChip } from "./EventResourceChip"
import { ResourceActions } from "./ResourceActions"
import { FollowInWorktreeMenu } from "./FollowInWorktreeMenu"
import { followResourceState, isArchivedEvent } from "../lib/openEvent"
import { eventTaskKey } from "../lib/taskEventKey"

/**
 * Full detail for one timeline event.
 *
 * Exists because the row deliberately clamps the body to keep the feed
 * scannable, which left long comments unreadable in the UI — the text was
 * fetched and then thrown away. Here it is shown in full.
 */
export function EventDetailsModal({ e, onClose, resolveResource, path, onMakeTask }: {
  e: TimelineEvent | null
  onClose: () => void
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
  /**
   * The worktree this modal is shown in, so a cmux tab in ITS workspace is
   * preferred by the open button. Defaults to the first worktree following
   * the event.
   */
  path?: string
  /**
   * Offers "Make task". This modal closes first: the task modal opens over
   * the page, and two modals stacked would leave this one behind it.
   */
  onMakeTask?: (e: TimelineEvent) => void
}) {
  const actionResource = e?.resource_url ? eventResource(e, resolveResource) : undefined
  const [, navigate] = useLocation()
  // Where a review comment sits in a diff view; a 404 (no worktree tracks the
  // PR, or the comment is gone) just means no button.
  const locate = useQuery({
    queryKey: ["pr-comment-locate", e?.id, path],
    queryFn: () => api.locatePRComment(e!.id, path),
    enabled: e?.type === "pr_review_comment",
    retry: false,
  })

  /*
   * Re-follow an archived resource: go to the chosen worktree, whose page
   * opens its follow modal with the URL — and the custom name and
   * description, which outlive the subscription — already filled in.
   */
  const followIn = (worktreePath: string) => {
    if (!e?.resource_url) return
    onClose()
    navigate(`/worktree/${encodeURIComponent(worktreePath)}`, {
      state: followResourceState({
        url: e.resource_url,
        name: actionResource?.custom_name || undefined,
        description: actionResource?.custom_description || undefined,
      }),
    })
  }

  return (
    <Modal opened={!!e} onClose={onClose} size="lg" title={
      e ? (
        <Group gap={8} wrap="nowrap">
          <EventDot type={e.type} label={e.type_label} taskState={e.task_state} />
          <Text fw={600} size="sm">{eventLabel(e.type, e.type_label)}</Text>
        </Group>
      ) : null
    }>
      {e && (
        <Stack gap="sm">
          {isArchivedEvent(e) && (
            <Alert color="gray" variant="light" p="xs" icon={<IconArchive size={16} />}>
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <Text size="sm">This resource is no longer followed by a worktree.</Text>
                {e.resource_url && <FollowInWorktreeMenu onPick={(w) => followIn(w.path)} />}
              </Group>
            </Alert>
          )}
          {/*
            Context first: which resource this event is about, and which
            worktrees follow it. Both are read-only labels — the row that
            opened this modal is itself the way to the resource — but they
            still sit ahead of the content, so you do not have to scroll past
            a long comment to find out what you are reading about.
          */}
          {(e.resource_type || actionResource) && (
            <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
              <div style={{ flex: 1, minWidth: 0 }}>
                <EventResourceChip e={e} resolveResource={resolveResource} />
              </div>
              {/* The resource card's own control, so an already-open cmux tab
                  is offered here exactly as it is there. */}
              {actionResource && <ResourceActions r={actionResource} path={path ?? e.worktree_paths?.[0]} />}
            </Group>
          )}

          {e.worktrees.length > 0 && (
            <Group gap={6} wrap="wrap">
              {e.worktrees.map((w) => (
                // Worded as on the activity feed's rows.
                <Badge key={w} size="sm" color="blue" variant="light">Worktree: {w}</Badge>
              ))}
            </Group>
          )}

          <Divider />

          <Text fw={600} style={{ overflowWrap: "anywhere" }}>{e.title}</Text>
          <Text size="xs" c="dimmed">
            {e.author && `${e.author} · `}
            {rel(e.external_ts || e.ts)}
          </Text>

          {e.body && (
            // Preserve the author's line breaks; this is comment text, not prose.
            <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {e.body}
            </Text>
          )}

          {(locate.data || (onMakeTask && eventTaskKey(e))) && (
            <Group justify="flex-end">
              {locate.data && (
                <Button
                  size="xs"
                  variant="light"
                  color="grape"
                  onClick={() => {
                    const target = locate.data
                    onClose()
                    navigate(`/worktree/${encodeURIComponent(target.path)}?diff&prcomment=${target.comment_id}`)
                  }}
                >
                  Go to comment in diff view
                </Button>
              )}
              {onMakeTask && eventTaskKey(e) && (
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => {
                    onClose()
                    onMakeTask(e)
                  }}
                >
                  Make task
                </Button>
              )}
            </Group>
          )}
        </Stack>
      )}
    </Modal>
  )
}

/**
 * The resource to hand ResourceActions: the tracked one where known, else a
 * bare shape built from the event, which carries everything the buttons use.
 *
 * The URL always falls back to the event's own: the copy the server embeds
 * in an event is built from cached state, which has none, and ResourceActions
 * renders nothing without one. That copy is all a feed with no resolver gets
 * — a selected resource's own feed, the home page.
 */
function eventResource(
  e: TimelineEvent,
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined,
): ResourceDTO {
  const known = e.resource_type && e.resource_id
    ? resolveResource?.(e.resource_type, e.resource_id) ?? e.resource
    : undefined
  if (!known) return { type: e.resource_type, id: e.resource_id, url: e.resource_url, primary: false } as ResourceDTO
  return known.url ? known : { ...known, url: e.resource_url }
}
