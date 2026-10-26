import { useState } from "react"
import { ActionIcon, Anchor, Badge, Box, Button, Group, Stack, Text, Tooltip } from "@mantine/core"
import { IconPencil, IconTrash } from "@tabler/icons-react"
import { HttpError } from "../../api/client"
import type { CommentSource, DiffBase, DiffRange, ReviewComment, ReviewCommentItem } from "../../api/types"
import {
  conflictComment,
  editDraftKey,
  NEW_DRAFT_KEY,
  newDraftTarget,
  useDeletedDrafts,
  useEditorDraft,
  useReviewCommentMutations,
  useReviewComments,
} from "../../hooks/useReviewComments"
import { useReviewSidebar } from "../../hooks/useReviewSidebar"
import { NotesMarkdown } from "../NotesMarkdown"
import { CommentEditor } from "./CommentEditor"
import { DeleteCommentModal } from "./DeleteCommentModal"
import type { CommentTarget } from "./commentRange"

export const SOURCE_STYLE: Record<CommentSource, { borderColor: string; label?: string; author: string; authorTip: string }> = {
  draft: {
    borderColor: "var(--mantine-color-blue-6)",
    author: "You (local)",
    authorTip: "Part of your local review, not submitted anywhere.",
  },
  pr: {
    borderColor: "var(--mantine-color-grape-6)",
    author: "PR comment",
    authorTip: "A review comment on the pull request, from GitHub.",
  },
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

function Frame({ comment, children }: { comment?: ReviewComment; children: React.ReactNode }) {
  const style = SOURCE_STYLE[comment?.source ?? "draft"]
  return (
    <Box
      data-review-comment-id={comment?.id}
      p="xs"
      // Inline, the card sits in pierre's monospace diff; it reads as prose.
      ff="text"
      style={{ borderLeft: `3px solid ${style.borderColor}`, background: "var(--mantine-color-body)", borderRadius: 4 }}
    >
      {children}
    </Box>
  )
}

// A comment's text, as Markdown (raw HTML is never rendered; see NotesMarkdown).
const Body = ({ text }: { text: string }) => (
  <Box style={{ overflowWrap: "anywhere" }}>
    <NotesMarkdown text={text} />
  </Box>
)
// Typed text kept to copy back: shown as typed.
const RawBody = ({ text }: { text: string }) => (
  <Text size="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</Text>
)

export function ReviewCommentCard({ path, comment, variant, onJump, jumpDisabledReason, viewKey }: {
  path: string
  comment: ReviewCommentItem
  variant: "inline" | "sidebar"
  onJump?: () => void
  jumpDisabledReason?: string
  /** The view (`old_rev..new_rev`) the comment's `view` position is for, when known. */
  viewKey?: string
}) {
  const { update } = useReviewCommentMutations(path)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // "View all and copy" opens the sidebar, so it is offered only while closed.
  const [sidebarOpen, setSidebarOpen] = useReviewSidebar()
  // The open edit lives in the store, not here, so it survives the card
  // remounting (see EditorDraft): its text, the version it started from, and
  // the newer comment a save found edited elsewhere, whose version the next
  // save carries instead.
  const [draft, setDraft] = useEditorDraft(path, editDraftKey(variant, comment.id))
  const editing = !!draft
  const conflict = draft?.conflict
  // A save that found the comment deleted leaves a tombstone in the store, so
  // this state survives the list dropping the comment and the card remounting.
  const deleted = useDeletedDrafts(path)
  const tombstone = deleted.drafts.find((d) => d.comment.id === comment.id)
  const [error, setError] = useState<string>()

  const view = comment.view
  const outdated = view?.status === "outdated" || comment.prompt.status === "outdated"
  const shown = view?.status === "shown"
  const first = shown && view.start_line !== undefined ? view.start_line : comment.start_line
  const last = shown && view.end_line !== undefined ? view.end_line : comment.end_line
  const lines = first === last ? `${first}` : `${first}-${last}`

  const save = (text: string) => {
    if (!draft) return
    setError(undefined)
    // mutateAsync, not mutate's callbacks: those are dropped if the card
    // remounts before the save answers.
    const version = conflict?.version ?? draft.baseVersion ?? comment.version
    update.mutateAsync({ id: comment.id, version, body: text }).then(
      () => setDraft(undefined),
      (err: unknown) => {
        const newer = conflictComment(err)
        if (newer) setDraft((d) => d && { ...d, text, conflict: newer })
        else if (err instanceof HttpError && err.status === 404) {
          deleted.add({ comment, text, view: viewKey })
          setDraft(undefined)
        } else setError(errMessage(err))
      },
    )
  }

  if (tombstone) {
    return (
      <Frame comment={comment}>
        <Stack gap={4}>
          <Text size="xs" c="red">Deleted elsewhere</Text>
          <RawBody text={tombstone.text} />
          <Group>
            <Button size="compact-xs" variant="subtle" color="gray" onClick={() => deleted.dismiss(comment.id)}>
              Dismiss
            </Button>
          </Group>
        </Stack>
      </Frame>
    )
  }

  return (
    <Frame comment={comment}>
      <Stack gap={4}>
        <Group gap={6} justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap={6} wrap="wrap">
            {variant === "inline" && (
              // Who wrote it, and the way to the rest of the review.
              <>
                <Tooltip label={SOURCE_STYLE[comment.source].authorTip} withArrow>
                  <Text size="xs" fw={600}>{SOURCE_STYLE[comment.source].author}</Text>
                </Tooltip>
                {!sidebarOpen && (
                  <Anchor component="button" type="button" size="xs" onClick={() => setSidebarOpen(true)}>
                    View all and copy
                  </Anchor>
                )}
              </>
            )}
            {variant === "sidebar" &&
              (onJump ? (
                // The place is the jump. Disabled, the span keeps the reason's tooltip hoverable.
                <Tooltip label={jumpDisabledReason ?? "Jump to comment"} openDelay={jumpDisabledReason ? 0 : 500}>
                  <span>
                    <Anchor
                      component="button"
                      type="button"
                      size="xs"
                      ff="monospace"
                      fw={600}
                      ta="left"
                      c={jumpDisabledReason ? "dimmed" : undefined}
                      underline={jumpDisabledReason ? "never" : "hover"}
                      style={{ overflowWrap: "anywhere", cursor: jumpDisabledReason ? "default" : undefined }}
                      aria-label={`Jump to comment at ${comment.file}:${lines}`}
                      disabled={!!jumpDisabledReason}
                      onClick={onJump}
                    >
                      {`${comment.file}:${lines}`}
                    </Anchor>
                  </span>
                </Tooltip>
              ) : (
                <Text size="xs" ff="monospace" fw={600} style={{ overflowWrap: "anywhere" }}>
                  {`${comment.file}:${lines}`}
                </Text>
              ))}
            {comment.side === "old" && <Text size="xs" c="dimmed">(old)</Text>}
            {outdated && <Badge size="xs" color="yellow" variant="light">Out of date</Badge>}
          </Group>
          {!editing && (
            <Group gap={2} wrap="nowrap">
              {comment.editable && (
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  aria-label="Edit comment"
                  onClick={() => setDraft({ text: comment.body, baseVersion: comment.version })}
                >
                  <IconPencil size={14} />
                </ActionIcon>
              )}
              {comment.editable && (
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label="Delete comment"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              )}
            </Group>
          )}
        </Group>
        {variant === "sidebar" && view?.status === "not_in_view" && <Text size="xs" c="dimmed">Not in this view</Text>}
        {variant === "sidebar" && view?.status === "outside_changes" && (
          <Text size="xs" c="dimmed">Outside the changes</Text>
        )}
        {editing ? (
          <>
            {conflict && (
              <Stack gap={2}>
                <Text size="xs" c="orange">Changed elsewhere — your text is kept below</Text>
                <Body text={conflict.body} />
              </Stack>
            )}
            <CommentEditor
              initial={draft.text}
              onChange={(text) => setDraft((d) => d && { ...d, text })}
              submitLabel="Save"
              busy={update.isPending}
              error={error}
              onSubmit={save}
              onCancel={() => {
                setDraft(undefined)
                setError(undefined)
              }}
            />
          </>
        ) : (
          <Body text={comment.body} />
        )}
      </Stack>
      <DeleteCommentModal
        opened={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        path={path}
        id={comment.id}
        where={`${comment.file}:${lines}`}
      />
    </Frame>
  )
}

export function NewCommentCard({ path, target, view, onDone }: {
  path: string
  target: CommentTarget
  view: { base: DiffBase; range: DiffRange; oldRev: string; newRev: string }
  onDone: () => void
}) {
  const { create } = useReviewCommentMutations(path)
  const [error, setError] = useState<string>()
  // The typed text lives in the store, so it survives the card remounting
  // (see EditorDraft); a draft typed for another target is not this one's.
  const mine = newDraftTarget(view, target)
  const [stored, setDraft] = useEditorDraft(path, NEW_DRAFT_KEY)
  const draft = stored?.target === mine ? stored : undefined
  const drop = () => setDraft((d) => (d?.target === mine ? undefined : d))
  // The view's own list (DiffView's query, shared): the first comment starts the review.
  const started = (useReviewComments(path, { oldRev: view.oldRev, newRev: view.newRev }).data?.length ?? 0) > 0
  return (
    <Frame>
      <CommentEditor
        initial={draft?.text ?? ""}
        onChange={(text) => setDraft({ text, target: mine })}
        submitLabel={started ? "Add local comment" : "Start local review"}
        submitTooltip={started ? undefined : "Start collecting comments locally to hand off to an agent"}
        busy={create.isPending}
        error={error}
        onCancel={() => {
          drop()
          onDone()
        }}
        onSubmit={(body) => {
          setError(undefined)
          create
            .mutateAsync({
              file: target.file,
              side: target.side,
              start_line: target.start,
              end_line: target.end,
              body,
              base: view.base,
              ...(view.range === "all" ? {} : { from: view.range.from, to: view.range.to }),
              old_rev: view.oldRev,
              new_rev: view.newRev,
            })
            .then(
              () => {
                drop()
                onDone()
              },
              (err: unknown) => setError(errMessage(err)),
            )
        }}
      />
    </Frame>
  )
}
