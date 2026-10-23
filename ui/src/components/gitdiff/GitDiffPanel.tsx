import { useState } from "react"
import { ActionIcon, Box, Button, Group, Stack, Text, UnstyledButton } from "@mantine/core"
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react"
import type { WorktreeGit } from "../../api/types"
import { useDiffCommits, useDiffFiles } from "../../hooks/useDiffData"
import { useDiffSelection } from "../../hooks/useDiffSelection"
import { useDiffView } from "../../hooks/useDiffView"
import { useWorktreeGit } from "../../hooks/useWorktreeGit"
import { diffUnavailable } from "../../lib/diffLabels"
import { CompareSelect } from "./CompareSelect"
import { FilesChangedList } from "./FilesChangedList"
import { Loading } from "./Loading"
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
  if (!git.data) return <Loading />
  return (
    <Stack gap="sm">
      <GitSummary path={path} git={git.data} repo={repo} updated={updated} />
      {git.data.on_disk && <FilesChanged path={path} git={git.data} />}
    </Stack>
  )
}

/**
 * Whether the Files changed list is expanded. One choice for every worktree,
 * remembered per browser like the other display preferences. Collapsed by
 * default, so the details card stays compact above the page's content.
 */
const FILES_OPEN_KEY = "worktree.filesChangedOpen"

function readFilesOpen(): boolean {
  try {
    return window.localStorage.getItem(FILES_OPEN_KEY) === "true"
  } catch {
    return false
  }
}

function writeFilesOpen(open: boolean): void {
  try {
    window.localStorage.setItem(FILES_OPEN_KEY, open ? "true" : "false")
  } catch {
    // Storage blocked or full: the choice lasts for this page view.
  }
}

/**
 * "▸ Files changed (N) +x −y · Compare with · Changes from · View diff", then
 * the list while expanded. The selection is the worktree's shared one, so the
 * diff view and the tab badge follow it.
 */
function FilesChanged({ path, git }: { path: string; git: WorktreeGit }) {
  const diffView = useDiffView()
  const [open, setOpen] = useState(readFilesOpen)
  const toggle = () => {
    setOpen(!open)
    writeFilesOpen(!open)
  }
  // The base picks which commit list to load, and the list's id decides
  // whether the stored range still applies — so read the base first, then
  // the selection against the loaded list. Both instances share one store.
  const { base } = useDiffSelection(path, undefined)
  const baseRef = base === "merge-base" ? git.main_upstream : git.tracking
  const unavailable = diffUnavailable(git, base)

  const commits = useDiffCommits(path, base, !unavailable, git.fingerprint)
  const sel = useDiffSelection(path, commits.data?.list_id)
  // The range names commits from this list, so wait for it before asking.
  // Loaded while collapsed too: the header's count and totals come from it.
  const files = useDiffFiles(path, base, sel.range, !unavailable && !!commits.data, git.fingerprint)

  const list = files.data?.files
  const additions = list?.reduce((n, f) => n + f.additions, 0) ?? 0
  const deletions = list?.reduce((n, f) => n + f.deletions, 0) ?? 0
  const error = commits.error ?? files.error

  return (
    <Stack gap="xs">
      <Group gap="md" wrap="wrap" align="center">
        <Group gap={8} wrap="nowrap">
          <ActionIcon size="sm" variant="subtle" color="gray" aria-label={open ? "Hide files" : "Show files"} onClick={toggle}>
            {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          </ActionIcon>
          {/* The chevron is the labelled control; the title is a larger
              target for the same toggle, so it stays out of the tab order. */}
          <UnstyledButton tabIndex={-1} onClick={toggle}>
            <Text size="sm" fw={600}>
              {list ? `Files changed (${list.length})` : "Files changed"}
            </Text>
          </UnstyledButton>
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
      {/* Collapsed, only what explains a header with no count stays. */}
      <Box>
        {unavailable ? (
          <Text size="xs" c="dimmed" fs="italic">{unavailable}</Text>
        ) : error && !list ? (
          <Text size="xs" c="red">Could not load changes{baseRef ? ` against ${baseRef}` : ""}: {error.message}</Text>
        ) : !open ? null : !list ? (
          <Loading />
        ) : list.length === 0 ? (
          <Text size="xs" c="dimmed">No changes</Text>
        ) : (
          <FilesChangedList path={path} files={list} onOpenFile={(f) => diffView.enter(f)} onViewDiff={() => diffView.enter()} />
        )}
      </Box>
    </Stack>
  )
}
