import { type ReactNode, useState } from "react"
import { Anchor, Avatar, Badge, Box, Button, Group, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core"
import { useQueryClient } from "@tanstack/react-query"
import type { PRRefDTO, PRThread, PRWriteMode, ResourceDTO } from "../../api/types"
import { usePRCommentsSummary } from "../../hooks/usePRComments"
import { prWriteError, summaryPR, usePRWriteMutations } from "../../hooks/usePRWrite"
import { useEditorDraft } from "../../hooks/useReviewComments"
import { useReviewSidebar, useReviewSidebarTab } from "../../hooks/useReviewSidebar"
import { relativeTime } from "../../lib/relativeTime"
import { MarkAllReadButton } from "../MarkAllReadButton"
import { KeyHint } from "../search/KeyHint"
import { UnreadMarkerDot } from "../UnreadMarkerDot"
import { CommentEditor } from "./CommentEditor"
import { prReviewLabel, prReviewTooltip, replyNowLabel, replyNowTooltip } from "./prWriteCopy"
import { Body, Frame, SOURCE_STYLE } from "./ReviewCommentCard"

const PREVIEW = 40

/**
 * Where Mark all read goes, sized by an invisible copy of the button that is
 * always there, so the button appearing or going never changes the card's
 * height (or wraps its header differently) and code never shifts under it.
 */
function MarkReadSlot({ children }: { children: ReactNode }) {
  return (
    <Box data-mark-read-slot style={{ display: "inline-grid" }}>
      <Button
        aria-hidden
        tabIndex={-1}
        size="compact-sm"
        rightSection={<KeyHint decorative>R</KeyHint>}
        style={{ gridArea: "1 / 1", visibility: "hidden" }}
      >
        Mark all read
      </Button>
      <Box style={{ gridArea: "1 / 1" }}>{children}</Box>
    </Box>
  )
}

/** Why a thread not drawn in the diff has nowhere to jump to. */
function jumpBlockedReason(status: NonNullable<PRThread["view"]>["status"] | undefined): string {
  switch (status) {
    case "unavailable":
      return "This comment's commit isn't available locally"
    case "outside_changes":
      return "Outside the changes"
    case "not_in_view":
      return "Not in this view: its file has no changes in the selected commits"
    default:
      return "Out of date: its lines aren't in this view"
  }
}

/**
 * Reply, under a thread, and the editor it opens: to the pending review or
 * straight onto the PR. The typed text is kept per thread in the draft store,
 * so it survives the card remounting.
 */
function ReplyBox({ path, thread, pr, pending }: { path: string; thread: PRThread; pr: PRRefDTO; pending: boolean }) {
  const { reply } = usePRWriteMutations(path)
  const [draft, setDraft] = useEditorDraft(path, `reply:${thread.id}`)
  const [error, setError] = useState<string>()
  const first = thread.comments[0]
  if (!first) return null
  if (!draft) {
    return (
      <Group>
        <Anchor component="button" type="button" size="xs" c="grape" onClick={() => setDraft({ text: "" })}>
          Reply
        </Anchor>
      </Group>
    )
  }
  const post = (mode: PRWriteMode) => (body: string) => {
    setError(undefined)
    reply.mutateAsync({ thread_id: thread.id, in_reply_to: first.id, mode, body }).then(
      () => setDraft(undefined),
      (err: unknown) => setError(prWriteError(err)),
    )
  }
  const busy = (mode: PRWriteMode) => reply.isPending && reply.variables?.mode === mode
  return (
    <CommentEditor
      initial={draft.text}
      onChange={(text) => setDraft((d) => d && { ...d, text })}
      error={error}
      onCancel={() => {
        setDraft(undefined)
        setError(undefined)
      }}
      actions={[
        {
          key: "review",
          label: prReviewLabel(pr.number, pending),
          tooltip: prReviewTooltip(pr.number),
          busy: busy("review"),
          onSubmit: post("review"),
        },
        {
          key: "single",
          label: replyNowLabel(pr.number),
          tooltip: replyNowTooltip(pr.number),
          variant: "light",
          busy: busy("single"),
          onSubmit: post("single"),
        },
      ]}
    />
  )
}

/** A card for one PR review thread: every comment, the place, and the way to GitHub. */
export function PRThreadCard({ path, thread, pr, variant, unreadIds, prResource, onJump }: {
  path: string
  thread: PRThread
  pr: PRRefDTO
  variant: "inline" | "sidebar"
  unreadIds: ReadonlySet<number>
  prResource?: ResourceDTO
  onJump?: () => void
}) {
  const qc = useQueryClient()
  const [, setReviewOpen] = useReviewSidebar()
  const [, setTab] = useReviewSidebarTab()
  const [expanded, setExpanded] = useState(false)
  // Replies need the PR, and the watcher on: otherwise there's no Reply.
  const summary = usePRCommentsSummary(path).data
  const canReply = !!summaryPR(summary) && summary?.state !== "off"

  const view = thread.view
  const shown = view?.status === "shown"
  const first = shown && view.start_line !== undefined ? view.start_line : thread.start_line
  const last = shown && view.end_line !== undefined ? view.end_line : thread.end_line
  const place = `${thread.file}:${first === last ? first : `${first}-${last}`}`
  const outdated = view?.status === "outdated" || view?.status === "unavailable" || thread.outdated
  // Only a thread drawn in the diff has somewhere to jump to; anything else
  // says why instead of a link that does nothing.
  const jumpDisabledReason = shown ? undefined : jumpBlockedReason(view?.status)
  const unread = prResource ? thread.comments.some((c) => unreadIds.has(c.id)) : false

  if (thread.resolved && !expanded) {
    const text = thread.comments[0]?.body ?? ""
    const preview = text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text
    return (
      <Frame source="pr" data-pr-thread-id={thread.id}>
        <UnstyledButton onClick={() => setExpanded(true)} style={{ width: "100%" }}>
          <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
            {`Resolved · @${thread.comments[0]?.author} · ${place} — ${preview}`}
          </Text>
        </UnstyledButton>
      </Frame>
    )
  }

  const placeLabel =
    variant === "sidebar" ? (
      onJump ? (
        <Tooltip label={jumpDisabledReason ?? "Jump to comment"} openDelay={jumpDisabledReason ? 0 : 500}>
          <span>
            <Anchor
              component="button"
              type="button"
              size="xs"
              ff="monospace"
              fw={600}
              ta="left"
              c={jumpDisabledReason ? "dimmed" : "grape"}
              underline={jumpDisabledReason ? "never" : "hover"}
              style={{ overflowWrap: "anywhere", cursor: jumpDisabledReason ? "default" : undefined }}
              aria-label={`Jump to comment at ${place}`}
              disabled={!!jumpDisabledReason}
              onClick={onJump}
            >
              {place}
            </Anchor>
          </span>
        </Tooltip>
      ) : (
        <Text size="xs" ff="monospace" fw={600} style={{ overflowWrap: "anywhere" }}>{place}</Text>
      )
    ) : null

  return (
    <Frame source="pr" data-pr-thread-id={thread.id}>
      <Stack gap={6}>
        {thread.resolved && (
          <UnstyledButton onClick={() => setExpanded(false)}>
            <Text size="xs" c="dimmed">Resolved · collapse</Text>
          </UnstyledButton>
        )}
        {(placeLabel || outdated) && (
          <Group gap={6}>
            {placeLabel}
            {outdated && <Badge size="xs" color="yellow" variant="light">Outdated</Badge>}
          </Group>
        )}
        {thread.comments.map((c, i) => (
          <Stack key={c.id} gap={2}>
            <Group gap={6} wrap="wrap">
              <Avatar size={16} src={c.avatar_url} alt="" />
              <Tooltip label={SOURCE_STYLE.pr.authorTip} withArrow>
                <Text size="xs" fw={600}>{`@${c.author} on PR #${pr.number}`}</Text>
              </Tooltip>
              <Text size="xs" c="dimmed">{relativeTime(c.created_at)}</Text>
              {c.pending && <Badge size="xs" color="gray" variant="light">Pending</Badge>}
              {/* Unread changes never resize the card: the dot and the
                  button each keep a slot that is always laid out. */}
              <span data-unread-slot style={{ display: "inline-flex", width: 7, height: 7, flexShrink: 0 }}>
                {unreadIds.has(c.id) && <UnreadMarkerDot label="unread comment" />}
              </span>
              {i === 0 && variant === "inline" && (
                <Anchor component="button" type="button" size="xs" c="grape" onClick={() => { setReviewOpen(true); setTab("pr") }}>
                  View all
                </Anchor>
              )}
              {i === 0 && (
                <Anchor href={c.url} target="_blank" rel="noreferrer" size="xs" c="grape">
                  View on GitHub
                </Anchor>
              )}
              {i === 0 && prResource && (
                <MarkReadSlot>
                  {unread && (
                    <MarkAllReadButton
                      single
                      resources={[prResource]}
                      feed={{ worktree: path, path, showResource: false }}
                      taskScope={{ kind: "resource", type: "pr", id: prResource.id }}
                      onMarked={() => void qc.invalidateQueries({ queryKey: ["pr-comments", path] })}
                    />
                  )}
                </MarkReadSlot>
              )}
            </Group>
            <Body text={c.body} imagesAsLinks />
          </Stack>
        ))}
        {canReply && <ReplyBox path={path} thread={thread} pr={pr} pending={(summary?.pending_comments ?? 0) > 0} />}
      </Stack>
    </Frame>
  )
}
