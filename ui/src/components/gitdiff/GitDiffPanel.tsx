import { Stack, Text } from "@mantine/core"
import { useWorktreeGit } from "../../hooks/useWorktreeGit"
import { GitSummary } from "./GitSummary"

/**
 * The Code tab: the git summary, then (Task 13) the Files changed section.
 * Mounted only while the tab is selected, so `fetch: true` asks the server to
 * nudge its background fetch exactly while someone is looking.
 */
export function GitDiffPanel({ path, repo, updated }: { path: string; repo: string; updated?: string }) {
  const git = useWorktreeGit(path, { fetch: true })
  if (git.isError && !git.data) {
    return <Text size="xs" c="red">Could not load git status: {git.error.message}</Text>
  }
  if (!git.data) return <Text size="xs" c="dimmed">Loading…</Text>
  return (
    <Stack gap="sm">
      <GitSummary git={git.data} repo={repo} updated={updated} />
      {/* Files changed (Task 13) goes here. */}
    </Stack>
  )
}
