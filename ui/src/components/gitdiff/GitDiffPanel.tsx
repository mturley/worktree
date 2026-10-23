import { Box, Button, Group, Stack, Text } from "@mantine/core"
import type { WorktreeGit } from "../../api/types"
import { useDiffCommits, useDiffFiles } from "../../hooks/useDiffData"
import { useDiffSelection } from "../../hooks/useDiffSelection"
import { useDiffView } from "../../hooks/useDiffView"
import { useWorktreeGit } from "../../hooks/useWorktreeGit"
import { CompareSelect } from "./CompareSelect"
import { FilesChangedList } from "./FilesChangedList"
import { GitSummary } from "./GitSummary"
import { RangePicker } from "./RangePicker"

/**
 * The Code tab: the git summary, then the Files changed section.
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
      {git.data.on_disk && <FilesChanged path={path} git={git.data} />}
    </Stack>
  )
}

/**
 * "Files changed (N) +x −y · Compare with · Changes from · View diff", then
 * the list. The selection is the worktree's shared one, so the diff view and
 * the tab badge follow it.
 */
function FilesChanged({ path, git }: { path: string; git: WorktreeGit }) {
  const diffView = useDiffView()
  // The base picks which commit list to load, and the list's id decides
  // whether the stored range still applies — so read the base first, then
  // the selection against the loaded list. Both instances share one store.
  const { base } = useDiffSelection(path, undefined)
  const baseRef = base === "merge-base" ? git.main_upstream : git.tracking
  const unavailable =
    base === "merge-base"
      ? !git.main_upstream || !git.merge_base
        ? "No merge base to compare with: main has no upstream."
        : undefined
      : !git.tracking
        ? "No tracking branch to compare with: this branch isn't pushed."
        : undefined

  const commits = useDiffCommits(path, base, !unavailable, git.fingerprint)
  const sel = useDiffSelection(path, commits.data?.list_id)
  // The range names commits from this list, so wait for it before asking.
  const files = useDiffFiles(path, base, sel.range, !unavailable && !!commits.data, git.fingerprint)

  const list = files.data?.files
  const additions = list?.reduce((n, f) => n + f.additions, 0) ?? 0
  const deletions = list?.reduce((n, f) => n + f.deletions, 0) ?? 0
  const error = commits.error ?? files.error

  return (
    <Stack gap="xs">
      <Group gap="md" wrap="wrap" align="center">
        <Group gap={8} wrap="nowrap">
          <Text size="sm" fw={600}>
            {list ? `Files changed (${list.length})` : "Files changed"}
          </Text>
          {list && (
            <Text size="xs" ff="monospace">
              <Text span inherit c="green">{`+${additions}`}</Text>{" "}
              <Text span inherit c="red">{`−${deletions}`}</Text>
            </Text>
          )}
        </Group>
        <CompareSelect
          value={base}
          onChange={sel.setBase}
          mainUpstream={git.main_upstream}
          tracking={git.tracking}
          labelPosition="left"
        />
        <RangePicker
          commits={commits.data?.commits ?? []}
          uncommittedCount={git.working.files}
          range={sel.range}
          onChange={sel.setRange}
          labelPosition="left"
          disabled={!!unavailable || !commits.data}
        />
        <Button size="xs" variant="light" disabled={!!unavailable} onClick={() => diffView.enter()}>
          View diff
        </Button>
      </Group>
      <Box>
        {unavailable ? (
          <Text size="xs" c="dimmed" fs="italic">{unavailable}</Text>
        ) : error && !list ? (
          <Text size="xs" c="red">Could not load changes{baseRef ? ` against ${baseRef}` : ""}: {error.message}</Text>
        ) : !list ? (
          <Text size="xs" c="dimmed">Loading…</Text>
        ) : list.length === 0 ? (
          <Text size="xs" c="dimmed">No changes</Text>
        ) : (
          <FilesChangedList path={path} files={list} onOpenFile={(f) => diffView.enter(f)} onViewDiff={() => diffView.enter()} />
        )}
      </Box>
    </Stack>
  )
}
