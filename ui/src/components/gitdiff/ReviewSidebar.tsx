import { useState } from "react"
import { Button, Group, Stack } from "@mantine/core"
import type { ReviewCommentItem } from "../../api/types"
import { useDeletedDrafts } from "../../hooks/useReviewComments"
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
export function ReviewSidebar({ path, comments, viewKey, prompt, onJump }: {
  path: string
  comments: ReviewCommentItem[]
  /** The view (`old_rev..new_rev`) the comments' positions are for, when known. */
  viewKey?: string
  prompt: string
  onJump: (c: ReviewCommentItem) => void
}) {
  const [sending, setSending] = useState(false)
  const [clearing, setClearing] = useState(false)
  const drafts = useDeletedDrafts(path).drafts
  const ids = new Set(comments.map((c) => c.id))
  const gone = drafts.filter((d) => !ids.has(d.comment.id))

  return (
    <Stack gap="xs" p="xs">
      <Group gap="xs" wrap="wrap">
        {/* The unread blue, as the breadcrumb's Pending local review comments (lighter on hover). */}
        <Button
          size="compact-xs"
          variant="filled"
          color="blue"
          vars={() => ({ root: { "--button-hover": "var(--mantine-color-blue-4)" } })}
          disabled={comments.length === 0}
          onClick={() => setSending(true)}
        >
          Copy comments for agent
        </Button>
        <Button
          size="compact-xs"
          variant="light"
          color="red"
          disabled={comments.length === 0}
          onClick={() => setClearing(true)}
        >
          Clear all
        </Button>
      </Group>
      {comments.map((c) => (
        <ReviewCommentCard
          key={c.id}
          path={path}
          comment={c}
          variant="sidebar"
          onJump={() => onJump(c)}
          jumpDisabledReason={c.view?.status === "outside_changes" ? OUTSIDE_CHANGES : undefined}
          viewKey={viewKey}
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
