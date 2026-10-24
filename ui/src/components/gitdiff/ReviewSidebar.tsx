import { useState } from "react"
import { ActionIcon, Button, Group, Stack, Tooltip } from "@mantine/core"
import { IconX } from "@tabler/icons-react"
import type { ReviewCommentItem } from "../../api/types"
import { useDeletedDrafts } from "../../hooks/useReviewComments"
import { KeyHint } from "../search/KeyHint"
import { ClearCommentsModal } from "./ClearCommentsModal"
import { ReviewCommentCard } from "./ReviewCommentCard"
import { SendToAgentModal } from "./SendToAgentModal"

const OUTSIDE_CHANGES = "Outside the changes — this file has no changes to show"

/**
 * The worktree's review comments, beside the diff (or in a drawer on a
 * phone): every comment in the list's order, then any deleted elsewhere
 * while being edited, kept until dismissed. Sends them to an agent as one
 * prompt, or clears them all.
 */
export function ReviewSidebar({ path, comments, prompt, onJump, onClose, escHint }: {
  path: string
  comments: ReviewCommentItem[]
  prompt: string
  onJump: (c: ReviewCommentItem) => void
  /** Given when the sidebar has its own close control (wide; the drawer has one). */
  onClose?: () => void
  escHint: boolean
}) {
  const [sending, setSending] = useState(false)
  const [clearing, setClearing] = useState(false)
  const drafts = useDeletedDrafts(path).drafts
  const ids = new Set(comments.map((c) => c.id))
  const gone = drafts.filter((d) => !ids.has(d.comment.id))

  return (
    <Stack gap="xs" p="xs">
      <Group gap="xs" wrap="wrap">
        <Button size="compact-xs" variant="light" disabled={comments.length === 0} onClick={() => setSending(true)}>
          Send comments to agent
        </Button>
        <Button
          size="compact-xs"
          variant="light"
          color="red"
          disabled={comments.length === 0}
          onClick={() => setClearing(true)}
        >
          Clear comments
        </Button>
        {onClose && (
          <Group gap={4} wrap="nowrap" ml="auto">
            {escHint && <KeyHint>Esc</KeyHint>}
            <Tooltip label="Close">
              <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Close review comments" onClick={onClose}>
                <IconX size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </Group>
      {comments.map((c) => (
        <ReviewCommentCard
          key={c.id}
          path={path}
          comment={c}
          variant="sidebar"
          onJump={() => onJump(c)}
          jumpDisabledReason={c.view?.status === "outside_changes" ? OUTSIDE_CHANGES : undefined}
        />
      ))}
      {gone.map((d) => (
        <ReviewCommentCard key={d.comment.id} path={path} comment={d.comment} variant="sidebar" />
      ))}
      <SendToAgentModal opened={sending} onClose={() => setSending(false)} prompt={prompt} />
      <ClearCommentsModal opened={clearing} onClose={() => setClearing(false)} path={path} count={comments.length} />
    </Stack>
  )
}
