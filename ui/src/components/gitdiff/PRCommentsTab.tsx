import { Anchor, Group, Stack, Switch, Text } from "@mantine/core"
import type { PRCommentsSummary, PRThread, PRThreads, ResourceDTO } from "../../api/types"
import { useShowPRComments } from "../../hooks/usePRComments"
import { Loading } from "./Loading"
import { PRThreadCard } from "./PRThreadCard"

function notice(summary: PRCommentsSummary): string | undefined {
  switch (summary.state) {
    case "off":
      return "The GitHub watcher is off, so PR comments aren't shown"
    case "no_token":
      return "No GitHub token is configured, so PR comments aren't shown"
    case "no_pr":
      return `No tracked PR for branch ${summary.branch ?? ""}`.trimEnd()
    case "error":
      return `Couldn't load PR comments: ${summary.message ?? "unknown error"}`
    default:
      return undefined
  }
}

/** The review sidebar's PR tab: the diff-view switch, the PR link, then its threads (open first). */
export function PRCommentsTab({ path, summary, threads, prResource, onJumpThread }: {
  path: string
  summary?: PRCommentsSummary
  threads?: PRThreads
  prResource?: ResourceDTO
  onJumpThread: (t: PRThread) => void
}) {
  const [show, setShow] = useShowPRComments()
  if (!summary) return <Stack p="xs"><Loading /></Stack>
  const text = notice(summary)
  if (text) return <Stack p="xs"><Text size="sm" c="dimmed">{text}</Text></Stack>

  const pr = summary.pr ?? threads?.pr
  const all = threads?.threads ?? []
  const ordered = [...all.filter((t) => !t.resolved), ...all.filter((t) => t.resolved)]
  const unreadIds = new Set(summary.unread_ids)
  return (
    <Stack gap="xs" p="xs">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Switch
          size="xs"
          label="Show in diff view"
          checked={show}
          onChange={(e) => setShow(e.currentTarget.checked)}
        />
        {pr && <Anchor href={pr.url} target="_blank" rel="noreferrer" size="sm" c="grape">{`PR #${pr.number}`}</Anchor>}
      </Group>
      {!threads && <Loading />}
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
