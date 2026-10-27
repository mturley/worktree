import { useState } from "react"
import { Button, Group, Stack, Tabs } from "@mantine/core"
import type { PRCommentsSummary, PRThread, PRThreads, ResourceDTO, ReviewCommentItem } from "../../api/types"
import { useReviewSidebarTab } from "../../hooks/useReviewSidebar"
import { PRCommentsTab } from "./PRCommentsTab"
import { useDeletedDrafts } from "../../hooks/useReviewComments"
import { ClearCommentsModal } from "./ClearCommentsModal"
import { ReviewCommentCard } from "./ReviewCommentCard"
import { SendToAgentModal } from "./SendToAgentModal"
import { SubmitReviewButton } from "./SubmitReviewButton"
import { PENDING_TAB_SUFFIX } from "./prWriteCopy"

const OUTSIDE_CHANGES = "Outside the changes — this file has no changes to show"

/**
 * The worktree's review comments, beside the diff (or in a drawer on a
 * phone): every comment in the list's order, then any deleted elsewhere
 * while being edited, kept until dismissed. Sends them to an agent as one
 * prompt, or clears them all.
 */
export function ReviewSidebar({ path, comments, viewKey, prompt, onJump, pr }: {
  path: string
  comments: ReviewCommentItem[]
  /** The view (`old_rev..new_rev`) the comments' positions are for, when known. */
  viewKey?: string
  prompt: string
  onJump: (c: ReviewCommentItem) => void
  pr?: {
    summary?: PRCommentsSummary
    threads?: PRThreads
    prResource?: ResourceDTO
    onJumpThread: (t: PRThread) => void
    onRefresh?: () => void
  }
}) {
  const [tab, setTab] = useReviewSidebarTab()
  const [sending, setSending] = useState(false)
  const [clearing, setClearing] = useState(false)
  const drafts = useDeletedDrafts(path).drafts
  const ids = new Set(comments.map((c) => c.id))
  const gone = drafts.filter((d) => !ids.has(d.comment.id))

  const local = (
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
        <SubmitReviewButton path={path} summary={pr?.summary} />
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

  return (
    <Tabs value={tab} onChange={(v) => setTab(v === "pr" ? "pr" : "local")} keepMounted={false}>
      <Tabs.List grow>
        <Tabs.Tab value="local">{`Local comments (${comments.length})`}</Tabs.Tab>
        <Tabs.Tab value="pr">
          {`PR comments (${pr?.summary?.open_threads ?? 0})${(pr?.summary?.pending_comments ?? 0) > 0 ? PENDING_TAB_SUFFIX : ""}`}
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="local">{local}</Tabs.Panel>
      <Tabs.Panel value="pr">
        <PRCommentsTab
          path={path}
          summary={pr?.summary}
          threads={pr?.threads}
          prResource={pr?.prResource}
          onJumpThread={pr?.onJumpThread ?? (() => {})}
          onRefresh={pr?.onRefresh}
        />
      </Tabs.Panel>
    </Tabs>
  )
}
