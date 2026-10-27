import { Anchor, Button, Group, Stack, Switch, Text } from "@mantine/core"
import type { PRCommentsSummary, PRThread, PRThreads, ResourceDTO } from "../../api/types"
import { useDiffView } from "../../hooks/useDiffView"
import { useShowPRComments } from "../../hooks/usePRComments"
import { SELECTION_PARAMS } from "../../hooks/useSelectedResource"
import { serializeResourceKey } from "../../lib/resourceKey"
import { Loading } from "./Loading"
import { PRThreadCard } from "./PRThreadCard"
import { pendingReviewNotice, stalePendingNotice } from "./prWriteCopy"
import { SubmitReviewButton } from "./SubmitReviewButton"

/** Why a summary or threads answer has nothing to show; undefined when ok. */
function notice(r: Pick<PRCommentsSummary, "state" | "branch" | "message">): string | undefined {
  switch (r.state) {
    case "off":
      return "The GitHub watcher is off, so PR comments aren't shown"
    case "no_token":
      return "No GitHub token is configured, so PR comments aren't shown"
    case "no_pr":
      return `No tracked PR for branch ${r.branch ?? ""}`.trimEnd()
    case "error":
      return `Couldn't load PR comments: ${r.message ?? "unknown error"}`
    default:
      return undefined
  }
}

/**
 * The review sidebar's PR tab: the diff-view switch, the PR link, then its
 * PINNED threads (open first). A summary poll never replaces them: a failed
 * or unavailable summary is a notice above the cards, and new comments
 * arrive only through `onRefresh`, the user's click.
 */
export function PRCommentsTab({ path, summary, threads, prResource, onJumpThread, onRefresh }: {
  path: string
  summary?: PRCommentsSummary
  threads?: PRThreads
  prResource?: ResourceDTO
  onJumpThread: (t: PRThread) => void
  /** Reloads the threads (the user's own Refresh). */
  onRefresh?: () => void
}) {
  const [show, setShow] = useShowPRComments()
  const diffView = useDiffView()
  if (!summary && !threads) return <Stack p="xs"><Loading /></Stack>

  const summaryNotice = summary ? notice(summary) : undefined
  const threadsNotice = threads ? notice(threads) : undefined
  const notices = [...new Set([summaryNotice, threadsNotice].filter((n): n is string => n !== undefined))]
  const pr = threads?.pr ?? summary?.pr
  const all = threads?.threads ?? []
  const ordered = [...all.filter((t) => !t.resolved), ...all.filter((t) => t.resolved)]
  const unreadIds = new Set(summary?.unread_ids)
  // Comments GitHub counts that the pinned list doesn't have yet (the view
  // opened before the review existed): the user's Refresh brings them in.
  const counted = summary?.state === "ok" ? summary.open_threads : 0
  const newOnGitHub = threads?.state === "ok" && all.length === 0 && counted > 0
  const showControls = summary?.state === "ok" || all.length > 0
  const pendingCount = summary?.state === "ok" ? summary.pending_comments : 0
  const stalePending = summary?.state === "ok" ? summary.stale_pending_commit : undefined

  return (
    <Stack gap="xs" p="xs">
      {showControls && (
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Switch
            size="xs"
            label="Show in diff view"
            checked={show}
            onChange={(e) => setShow(e.currentTarget.checked)}
          />
          {pr && (
            // The PR's resource view on the worktree page: leaving the diff
            // and selecting it in one navigation (its default tab).
            <Anchor
              component="button"
              type="button"
              role="link"
              size="sm"
              c="grape"
              onClick={() => diffView.leave({ resource: serializeResourceKey({ type: "pr", id: pr.id }) }, SELECTION_PARAMS)}
            >
              {`PR #${pr.number}`}
            </Anchor>
          )}
        </Group>
      )}
      {pr && pendingCount > 0 && (
        <Stack gap={4}>
          <Group gap="xs" wrap="wrap">
            <Text size="sm">{pendingReviewNotice(pr.number, pendingCount)}</Text>
            <SubmitReviewButton path={path} summary={summary} />
          </Group>
          {stalePending && <Text size="xs" c="yellow">{stalePendingNotice(pr.number, stalePending)}</Text>}
        </Stack>
      )}
      {notices.map((n) => <Text key={n} size={all.length > 0 ? "xs" : "sm"} c="dimmed">{n}</Text>)}
      {!threads && summary?.state === "ok" && <Loading />}
      {newOnGitHub && (
        <Group gap={6} wrap="nowrap">
          <Text size="xs" c="yellow">New PR comments</Text>
          {onRefresh && (
            <Button size="compact-xs" variant="light" color="yellow" onClick={onRefresh}>
              Refresh
            </Button>
          )}
        </Group>
      )}
      {pr && ordered.map((t) => (
        <PRThreadCard
          key={t.id}
          path={path}
          thread={t}
          pr={pr}
          variant="sidebar"
          unreadIds={unreadIds}
          prResource={prResource}
          onJump={() => onJumpThread(t)}
        />
      ))}
    </Stack>
  )
}
