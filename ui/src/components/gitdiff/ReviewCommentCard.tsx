import { useState } from "react"
import { ActionIcon, Badge, Box, Button, Group, Stack, Text, Tooltip } from "@mantine/core"
import { IconArrowRight, IconPencil, IconTrash } from "@tabler/icons-react"
import { HttpError } from "../../api/client"
import type { CommentSource, DiffBase, DiffRange, ReviewComment, ReviewCommentItem } from "../../api/types"
import { conflictComment, useReviewCommentMutations } from "../../hooks/useReviewComments"
import { CommentEditor } from "./CommentEditor"
import type { CommentTarget } from "./commentRange"

export const SOURCE_STYLE: Record<CommentSource, { borderColor: string; label?: string }> = {
  draft: { borderColor: "var(--mantine-color-blue-6)" },
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

function Frame({ comment, children }: { comment?: ReviewComment; children: React.ReactNode }) {
  const style = SOURCE_STYLE[comment?.source ?? "draft"]
  return (
    <Box
      data-review-comment-id={comment?.id}
      p="xs"
      style={{ borderLeft: `3px solid ${style.borderColor}`, background: "var(--mantine-color-body)", borderRadius: 4 }}
    >
      {children}
    </Box>
  )
}

const Body = ({ text }: { text: string }) => (
  <Text size="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</Text>
)

export function ReviewCommentCard({ path, comment, variant, onJump, jumpDisabledReason }: {
  path: string
  comment: ReviewCommentItem
  variant: "inline" | "sidebar"
  onJump?: () => void
  jumpDisabledReason?: string
}) {
  const { update, remove } = useReviewCommentMutations(path)
  const [editing, setEditing] = useState(false)
  // Set when a save found the comment edited elsewhere: the newer comment,
  // whose version the next save carries.
  const [conflict, setConflict] = useState<ReviewComment>()
  // Set when a save found the comment deleted: the text that was being typed.
  const [deletedText, setDeletedText] = useState<string>()
  const [error, setError] = useState<string>()
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null

  const view = comment.view
  const outdated = view?.status === "outdated" || comment.prompt.status === "outdated"
  const shown = view?.status === "shown"
  const first = shown && view.start_line !== undefined ? view.start_line : comment.start_line
  const last = shown && view.end_line !== undefined ? view.end_line : comment.end_line
  const lines = first === last ? `${first}` : `${first}-${last}`

  const save = (text: string) => {
    setError(undefined)
    update.mutate(
      { id: comment.id, version: conflict?.version ?? comment.version, body: text },
      {
        onSuccess: () => {
          setEditing(false)
          setConflict(undefined)
        },
        onError: (err) => {
          const newer = conflictComment(err)
          if (newer) setConflict(newer)
          else if (err instanceof HttpError && err.status === 404) {
            setDeletedText(text)
            setEditing(false)
          } else setError(errMessage(err))
        },
      },
    )
  }

  if (deletedText !== undefined) {
    return (
      <Frame comment={comment}>
        <Stack gap={4}>
          <Text size="xs" c="red">Deleted elsewhere</Text>
          <Body text={deletedText} />
          <Group>
            <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setDismissed(true)}>
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
            {variant === "sidebar" && (
              <Text size="xs" ff="monospace" fw={600} style={{ overflowWrap: "anywhere" }}>
                {`${comment.file}:${lines}`}
              </Text>
            )}
            {comment.side === "old" && <Text size="xs" c="dimmed">(old)</Text>}
            {outdated && <Badge size="xs" color="yellow" variant="light">Out of date</Badge>}
          </Group>
          {!editing && (
            <Group gap={2} wrap="nowrap">
              {comment.editable && (
                <ActionIcon size="sm" variant="subtle" aria-label="Edit comment" onClick={() => setEditing(true)}>
                  <IconPencil size={14} />
                </ActionIcon>
              )}
              {comment.editable && (
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label="Delete comment"
                  loading={remove.isPending}
                  onClick={() => remove.mutate(comment.id)}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              )}
              {variant === "sidebar" && onJump && (
                <Tooltip label={jumpDisabledReason} disabled={!jumpDisabledReason}>
                  <span>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      aria-label="Jump to comment"
                      disabled={!!jumpDisabledReason}
                      onClick={onJump}
                    >
                      <IconArrowRight size={14} />
                    </ActionIcon>
                  </span>
                </Tooltip>
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
              initial={comment.body}
              submitLabel="Save"
              busy={update.isPending}
              error={error}
              onSubmit={save}
              onCancel={() => {
                setEditing(false)
                setConflict(undefined)
                setError(undefined)
              }}
            />
          </>
        ) : (
          <Body text={comment.body} />
        )}
        {remove.isError && <Text size="xs" c="red">{errMessage(remove.error)}</Text>}
      </Stack>
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
  return (
    <Frame>
      <CommentEditor
        initial=""
        submitLabel="Comment"
        busy={create.isPending}
        error={error}
        onCancel={onDone}
        onSubmit={(body) => {
          setError(undefined)
          create.mutate(
            {
              file: target.file,
              side: target.side,
              start_line: target.start,
              end_line: target.end,
              body,
              base: view.base,
              ...(view.range === "all" ? {} : { from: view.range.from, to: view.range.to }),
              old_rev: view.oldRev,
              new_rev: view.newRev,
            },
            { onSuccess: onDone, onError: (err) => setError(errMessage(err)) },
          )
        }}
      />
    </Frame>
  )
}
