import { useState } from "react"
import { Anchor, Avatar, Badge, Group, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core"
import { useQueryClient } from "@tanstack/react-query"
import type { PRRefDTO, PRThread, ResourceDTO } from "../../api/types"
import { useReviewSidebar, useReviewSidebarTab } from "../../hooks/useReviewSidebar"
import { relativeTime } from "../../lib/relativeTime"
import { MarkAllReadButton } from "../MarkAllReadButton"
import { UnreadMarkerDot } from "../UnreadMarkerDot"
import { Body, Frame, SOURCE_STYLE } from "./ReviewCommentCard"

const PREVIEW = 40

/** A read-only card for one PR review thread: every comment, the place, and the way to GitHub. */
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

  const view = thread.view
  const shown = view?.status === "shown"
  const first = shown && view.start_line !== undefined ? view.start_line : thread.start_line
  const last = shown && view.end_line !== undefined ? view.end_line : thread.end_line
  const place = `${thread.file}:${first === last ? first : `${first}-${last}`}`
  const outdated = view?.status === "outdated" || view?.status === "unavailable" || thread.outdated
  const jumpDisabledReason =
    view?.status === "unavailable"
      ? "This comment's commit isn't available locally"
      : view?.status === "outside_changes"
        ? "Outside the changes"
        : undefined
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
              {unreadIds.has(c.id) && <UnreadMarkerDot label="unread comment" />}
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
            </Group>
            <Body text={c.body} />
          </Stack>
        ))}
        {unread && prResource && (
          <Group>
            <MarkAllReadButton
              single
              resources={[prResource]}
              feed={{ worktree: path, path, showResource: false }}
              taskScope={{ kind: "resource", type: "pr", id: prResource.id }}
              onMarked={() => void qc.invalidateQueries({ queryKey: ["pr-comments", path] })}
            />
          </Group>
        )}
      </Stack>
    </Frame>
  )
}
