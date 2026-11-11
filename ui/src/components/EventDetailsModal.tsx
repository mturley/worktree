import { lazy, Suspense, useState } from "react"
import { Alert, Badge, Button, Divider, Group, Loader, Modal, Stack, Text } from "@mantine/core"
import { TASK_BUTTON_STYLE } from "./tasks/taskButtonStyle"
import { IconArchive } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { api, HttpError } from "../api/client"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { eventLabel } from "../lib/eventMeta"
import { relativeTime as rel } from "../lib/relativeTime"
import { EventDot } from "./EventDot"
import { EventResourceChip } from "./EventResourceChip"
import { ResourceActions } from "./ResourceActions"
import { FollowInWorktreeMenu } from "./FollowInWorktreeMenu"
import { WorktreeName, WorktreePreview } from "./WorktreeName"
import { eventWorktrees, followResourceState, isArchivedEvent } from "../lib/openEvent"
import { eventTaskKey, taskEventNumericId } from "../lib/taskEventKey"
import { WorkLogEditor } from "./WorkLogEditor"
import { OpenInFullUiButton } from "./OpenInFullUiButton"
import { eventFullUiHref } from "../lib/fullUiLink"
import { useMiniModalFullScreen } from "../hooks/useMiniModalFullScreen"
import { isGitHubMarkdownBody } from "../lib/githubBody"
import { MARK_READ_BUTTON_PROPS, READ_BOX_BORDER, UNREAD_BOX_BORDER } from "../lib/unread"
import { canMarkEventRead, canMarkEventUnread, useMarkEventRead, useMarkEventUnread } from "../hooks/useMarkEventRead"
import { canMarkSlackEventRead, type SlackMarkPlan, useMarkSlackEventRead } from "../hooks/useMarkSlackEventRead"
import { BotMark } from "./BotMark"
import { DiffViewBoundary, installPreloadReload } from "./gitdiff/DiffViewBoundary"

/** Event types whose modal shows a diff of the description in place of the body. */
export const DESCRIPTION_DIFF_TYPES = ["jira_description_changed", "pr_description_changed"]

// The diff, and with it @pierre/diffs, is its own chunk: fetched the first
// time someone opens a description edit, never on a plain page load.
const DescriptionDiff = lazy(() => import("./DescriptionDiff"))
// Likewise the HTML parser a GitHub comment's rendering needs.
const GitHubCommentMarkdown = lazy(() => import("./GitHubCommentMarkdown"))
// A chunk missing after an upgrade reloads the page (once) instead of failing.
installPreloadReload()

/**
 * Full detail for one timeline event.
 *
 * Exists because the row deliberately clamps the body to keep the feed
 * scannable, which left long comments unreadable in the UI — the text was
 * fetched and then thrown away. Here it is shown in full.
 */
export function EventDetailsModal({ e: shown, onClose, resolveResource, path, onMakeTask, inTask, editable = true }: {
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
  /**
   * Shown over a task's own modal: no "Make task", since the task modal
   * would stack under a second one. Every other action stays.
   */
  inTask?: boolean
  /** False hides "Edit" on a work log (the deleted-task fallback has no task to write to). */
  editable?: boolean
}) {
  // This modal holds its own copy of an edited work log: the feed it was
  // opened from refetches, but this event prop does not change under us.
  const [patched, setPatched] = useState<TimelineEvent | null>(null)
  const e = patched && patched.id === shown?.id ? patched : shown
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = !!e && editingId === e.id
  const canEdit = !!e && editable && e.type === "task_work_logged" && taskEventNumericId(e) !== null
  const actionResource = e?.resource_url ? eventResource(e, resolveResource) : undefined
  const [, navigate] = useLocation()
  const fullScreen = useMiniModalFullScreen()
  const markEventRead = useMarkEventRead()
  const markEventUnread = useMarkEventUnread()
  const [marking, setMarking] = useState(false)
  // This modal holds its own copy of the event, and a feed filtered to unread
  // drops the row, so a mark made here has to be remembered here.
  const [marked, setMarked] = useState<{ id: string; unread: boolean } | null>(null)
  const unread = marked && marked.id === e?.id ? marked.unread : !!e?.unread
  const isSlack = !!e && canMarkSlackEventRead({ ...e, unread: true })
  const offerMarkRead = !!e && unread && (isSlack || canMarkEventRead({ ...e, unread }))
  const offerMarkUnread = !!e && !unread && canMarkEventUnread(e)
  const slackMark = useMarkSlackEventRead()
  // A Slack mark that would also mark older messages read, awaiting the
  // user's go-ahead: Slack has one cursor per thread, not one per message.
  const [slackConfirm, setSlackConfirm] = useState<{ id: string; plan: SlackMarkPlan } | null>(null)
  const pendingSlack = slackConfirm && slackConfirm.id === e?.id ? slackConfirm.plan : null

  const commitSlack = async (plan: SlackMarkPlan) => {
    if (!e) return
    setSlackConfirm(null)
    setMarking(true)
    await slackMark.mark(e, plan, {
      onDone: () => setMarked({ id: e.id, unread: false }),
      onUndone: () => setMarked({ id: e.id, unread: true }),
    })
    setMarking(false)
  }

  // Asks Slack where its cursor is first: the warning needs the count, and
  // the undo needs the cursor this mark replaces.
  const markSlackRead = async () => {
    if (!e) return
    setMarking(true)
    const plan = await slackMark.plan(e)
    setMarking(false)
    if (!plan) return
    if (plan.alreadyRead) {
      // Read in Slack since this was fetched: nothing to write.
      setMarked({ id: e.id, unread: false })
      slackMark.refresh()
    } else if (plan.older > 0) {
      setSlackConfirm({ id: e.id, plan })
    } else {
      await commitSlack(plan)
    }
  }

  const mark = async (toUnread: boolean) => {
    if (!e) return
    if (!toUnread && isSlack) return markSlackRead()
    const wasUnread = unread
    setMarking(true)
    await (toUnread ? markEventUnread : markEventRead)(e, {
      onDone: () => setMarked({ id: e.id, unread: toUnread }),
      onUndone: () => setMarked({ id: e.id, unread: wasUnread }),
    })
    setMarking(false)
  }

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

  const openWorktree = (worktreePath: string) => {
    onClose()
    navigate(`/worktree/${encodeURIComponent(worktreePath)}`)
  }

  const hasActions = !!e && !!(locate.data || offerMarkRead || offerMarkUnread || canEdit || (onMakeTask && !inTask && eventTaskKey(e)))
  const actions = e && hasActions ? (
    <>
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
      {offerMarkRead && (
        <Button size="xs" {...MARK_READ_BUTTON_PROPS} loading={marking} disabled={!!pendingSlack} onClick={() => void mark(false)}>
          Mark read
        </Button>
      )}
      {offerMarkUnread && (
        <Button size="xs" variant="light" loading={marking} onClick={() => void mark(true)}>
          Mark unread
        </Button>
      )}
      {canEdit && !editing && (
        <Button size="xs" variant="light" onClick={() => setEditingId(e.id)}>
          Edit
        </Button>
      )}
      {onMakeTask && !inTask && eventTaskKey(e) && (
        <Button
          size="xs"
          variant="light"
          style={TASK_BUTTON_STYLE}
          onClick={() => {
            onClose()
            onMakeTask(e)
          }}
        >
          Make task
        </Button>
      )}
    </>
  ) : null

  return (
    <Modal opened={!!e} onClose={onClose} size="lg" fullScreen={fullScreen}
      // A border, not an inset outline, which the sticky header paints over.
      // Always the same width, so clearing it does not shift the content.
      // The title fills the header, to put its button beside the close button.
      styles={{ content: { border: unread ? UNREAD_BOX_BORDER : READ_BOX_BORDER }, title: { flex: 1, minWidth: 0 } }}
      title={
      e ? (
        <Group gap={8} wrap="nowrap" justify="space-between" pe="xs">
          <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
            <EventDot type={e.type} label={e.type_label} taskState={e.task_state} />
            <Text fw={600} size="sm">{eventLabel(e.type, e.type_label)}</Text>
          </Group>
          <OpenInFullUiButton href={eventFullUiHref(e)} />
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
            worktrees follow it. The resource is a read-only label — the row
            that opened this modal is itself the way to it — and each worktree
            opens its page, the way out of the mini view, whose rows go nowhere
            else. They sit ahead of the content, so you do not have to scroll
            past a long comment to find out what you are reading about.
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

          {(e.worktrees.length > 0 || hasActions) && (
            <Group
              data-testid="worktree-row"
              justify={e.worktrees.length > 0 ? "space-between" : "flex-end"}
              wrap="wrap"
              align="flex-start"
              gap={6}
            >
              {e.worktrees.length > 0 && (
                <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
                  {eventWorktrees(e).map((w, i) => (
                    // Worded as on the activity feed's rows.
                    <WorktreePreview key={`${i}:${w.path ?? w.name}`} path={w.path}>
                      <Badge
                        // Only a path can be navigated to; a bare name stays a label.
                        {...(w.path
                          ? {
                              component: "button" as const,
                              type: "button" as const,
                              className: "worktree-chip-nav",
                              "aria-label": `Open worktree ${w.name}`,
                              onClick: () => openWorktree(w.path!),
                            }
                          : {})}
                        size="sm"
                        color="gray"
                        variant="outline"
                        maw={240}
                        style={{ textTransform: "none" }}
                      >
                        <WorktreeName path={w.path} name={w.name} />
                      </Badge>
                    </WorktreePreview>
                  ))}
                </Group>
              )}
              {hasActions && (
                <Group justify="flex-end" ml="auto" gap={6}>
                  {actions}
                </Group>
              )}
            </Group>
          )}

          {pendingSlack && unread && (
            <Alert color="yellow" variant="light" p="xs" data-testid="slack-mark-warning">
              <Stack gap={6}>
                <Text size="sm">
                  Marking this message as read also marks {pendingSlack.older} older{" "}
                  {pendingSlack.older === 1 ? "message" : "messages"} in the thread as read.
                </Text>
                <Group gap={6} justify="flex-end">
                  <Button size="xs" variant="default" onClick={() => setSlackConfirm(null)}>
                    Cancel
                  </Button>
                  <Button size="xs" {...MARK_READ_BUTTON_PROPS} onClick={() => void commitSlack(pendingSlack)}>
                    Mark read
                  </Button>
                </Group>
              </Stack>
            </Alert>
          )}

          <Divider />

          <Text fw={600} style={{ display: "flex", gap: 4 }}>
            <BotMark authorType={e.author_type} author={e.author} />
            <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{e.title}</span>
          </Text>
          <Text size="xs" c="dimmed">
            {e.author && `${e.author} · `}
            {rel(e.external_ts || e.ts)}{e.edited_at && " (edited)"}
          </Text>

          {editing ? (
            <WorkLogEditor
              event={e}
              onSaved={(next) => {
                setPatched(next)
                setEditingId(null)
              }}
              onDeleted={() => {
                setEditingId(null)
                onClose()
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : DESCRIPTION_DIFF_TYPES.includes(e.type) ? (
            <DescriptionChange key={e.id} id={e.id} />
          ) : e.body && isGitHubMarkdownBody(e.type) ? (
            // Images as links: one could be a tracking pixel, or an
            // attachment only GitHub's session can fetch.
            <Suspense fallback={<Loader size="xs" />}>
              <GitHubCommentMarkdown text={e.body} imagesAsLinks />
            </Suspense>
          ) : e.body && (
            // Preserve the author's line breaks; this is comment text, not prose.
            <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {e.body}
            </Text>
          )}

        </Stack>
      )}
    </Modal>
  )
}

/**
 * A description edit's diff, fetched when the modal opens. Everything else in
 * the modal is already there while it loads.
 */
function DescriptionChange({ id }: { id: string }) {
  const text = useQuery({
    queryKey: ["event-text-change", id],
    queryFn: () => api.eventTextChange(id),
    // An event's text never changes once stored.
    staleTime: Infinity,
    // A 404 means the text was never stored for this edit: asking again won't help.
    retry: (failures, err) => !(err instanceof HttpError && err.status === 404) && failures < 3,
  })
  if (text.isPending) return <Loading />
  if (text.isError) {
    if (text.error instanceof HttpError && text.error.status === 404) {
      return <Text size="sm" c="dimmed">Diff not available for this edit.</Text>
    }
    return <Text size="sm" c="red">Couldn't load the diff: {text.error.message}</Text>
  }
  return (
    <DiffViewBoundary>
      <Suspense fallback={<Loading />}>
        <DescriptionDiff oldText={text.data.old_text} newText={text.data.new_text} cacheKey={id} />
      </Suspense>
    </DiffViewBoundary>
  )
}

function Loading() {
  return (
    <Group gap="xs">
      <Loader size="xs" />
      <Text size="sm" c="dimmed">Loading diff…</Text>
    </Group>
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
