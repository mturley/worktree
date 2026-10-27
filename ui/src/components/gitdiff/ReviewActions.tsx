import { Button, Group } from "@mantine/core"
import type { WorktreeGit } from "../../api/types"
import { useDiffSelection } from "../../hooks/useDiffSelection"
import { useDiffView } from "../../hooks/useDiffView"
import { usePRCommentsSummary } from "../../hooks/usePRComments"
import { useReviewComments } from "../../hooks/useReviewComments"
import { diffUnavailable } from "../../lib/diffLabels"
import { codeTabLabel, countsAreUnread } from "../../lib/reviewCounts"
import { OpenInEditorButton } from "../OpenInEditorButton"

/**
 * How often the counts refresh while the Code tab isn't showing. The buttons
 * sit above the tab bar on every tab, but the counts only need to be live
 * where the changes are being looked at; elsewhere a slow refresh is enough.
 * (A diff view open on the same worktree keeps its own 5s poll: react-query
 * polls a shared query at its fastest observer's interval.)
 */
const IDLE_POLL_MS = 60_000

/**
 * "Open in editor · Review changes", above the worktree details card's tabs.
 * The Review changes label counts pending local comments and the PR's open
 * threads (with their unread), filled in the unread blue while any local
 * comment or unread PR comment waits. The button shows at once; the counts
 * fill in when they load.
 */
export function ReviewActions({ path, git, active }: {
  path: string
  git: WorktreeGit
  /** The Code tab is showing: refresh the counts at their usual pace. */
  active: boolean
}) {
  const diffView = useDiffView()
  // The same shared base as the Code tab's Files changed, so both agree on whether there is a diff.
  const { base } = useDiffSelection(path, undefined)
  const unavailable = diffUnavailable(git, base)
  const pollMs = active ? undefined : IDLE_POLL_MS
  // With no view, the worktree's whole list: every comment not yet cleared.
  const pending = useReviewComments(path, undefined, { pollMs }).data?.length ?? 0
  const prSummary = usePRCommentsSummary(path, { pollMs }).data
  const prOk = prSummary?.state === "ok"
  const openThreads = prOk ? prSummary.open_threads : 0
  const unread = prOk ? prSummary.unread_comments : 0
  const filled = countsAreUnread(pending, unread)
  return (
    <Group gap="xs" wrap="wrap">
      <OpenInEditorButton path={path} />
      {/* A review in progress is filled in the unread blue, as the diff view's
          own review button is, so it's hard to miss. */}
      <Button
        size="xs"
        variant={filled ? "filled" : "light"}
        color={filled ? "blue" : undefined}
        vars={filled ? () => ({ root: { "--button-hover": "var(--mantine-color-blue-4)" } }) : undefined}
        disabled={!!unavailable}
        onClick={() => diffView.enter()}
      >
        {codeTabLabel(pending, openThreads, unread)}
      </Button>
    </Group>
  )
}
