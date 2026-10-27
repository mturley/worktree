import { ActionIcon, Box, CopyButton, Group, Stack, Text, Tooltip } from "@mantine/core"
import { IconAlertTriangle, IconCheck, IconCopy } from "@tabler/icons-react"
import type { AheadBehind, WorktreeGit } from "../../api/types"
import { useIsWide } from "../../hooks/useIsWide"
import { unpushedLabel } from "../../lib/diffLabels"
import { relativeTime } from "../../lib/relativeTime"
import { InfoRow } from "../InfoRow"

const RIGHT_LABEL_WIDTH = 100

/** "3 modified · 1 untracked", or "clean" when the working tree has nothing outstanding. */
function workingSummary(w: WorktreeGit["working"]): string {
  const parts: string[] = []
  if (w.staged) parts.push(`${w.staged} staged`)
  if (w.modified) parts.push(`${w.modified} modified`)
  if (w.untracked) parts.push(`${w.untracked} untracked`)
  return parts.length === 0 ? "clean" : parts.join(" · ")
}

/** Ahead/behind on its own line, indented past the value of the ref it counts against. */
function AheadBehindLine({ ab }: { ab: AheadBehind | undefined }) {
  if (!ab) return null
  return (
    <Text size="xs" c="dimmed" pl={RIGHT_LABEL_WIDTH + 20}>
      {`(${ab.ahead} ahead · ${ab.behind} behind)`}
    </Text>
  )
}

/** A small copy-to-clipboard icon, after the value it copies. */
function CopyIcon({ value, label, tooltip }: { value: string; label: string; tooltip: string }) {
  return (
    <CopyButton value={value}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? "Copied" : tooltip}>
          <ActionIcon variant="subtle" color={copied ? "teal" : "gray"} size="xs" aria-label={label} onClick={copy}>
            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  )
}

/**
 * The worktree's directory, with a button that copies it. With ~ for the home
 * directory, copied as shown, like the Environment tab's paths. Heads the
 * worktree details card, above its tabs.
 */
export function DirectoryRow({ path, git }: { path: string; git: WorktreeGit }) {
  const dir = git.directory ?? path
  // Laid out like an InfoRow, but centred rather than baseline-aligned: a long
  // path wraps, and the label and copy button stay level with its middle (as
  // the card's controls beside this row do).
  return (
    <Group gap="xs" wrap="nowrap" align="center" style={{ minWidth: 0 }}>
      <Text size="xs" c="dimmed" miw={80} style={{ flex: "none", whiteSpace: "nowrap" }}>Directory</Text>
      <Text size="sm" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{dir}</Text>
      <CopyIcon value={dir} label="Copy directory path" tooltip="Copy directory path" />
    </Group>
  )
}

/**
 * The Code tab's summary: what this worktree is (left) and where it stands
 * against its merge base and tracking branch (right). Two columns wide,
 * stacked on a phone, or always (`oneColumn`) in a narrow place like the
 * diff view's file tree sidebar.
 */
export function GitSummary({ git, repo, updated, oneColumn = false }: {
  git: WorktreeGit
  repo?: string
  updated?: string
  oneColumn?: boolean
}) {
  return (
    <Stack gap={2}>
      <Columns git={git} repo={repo} updated={updated} oneColumn={oneColumn} />
    </Stack>
  )
}

function Columns({ git, repo, updated, oneColumn }: { git: WorktreeGit; repo?: string; updated?: string; oneColumn: boolean }) {
  const wide = useIsWide() && !oneColumn
  if (!git.on_disk) {
    return <Text size="xs" c="dimmed" fs="italic">Worktree is missing from disk</Text>
  }
  const dirty = git.working.staged || git.working.modified || git.working.untracked
  const short = git.merge_base?.slice(0, 7)
  const unpushed = unpushedLabel(git)

  return (
    <Box
      style={{
        display: "flex",
        flexDirection: wide ? "row" : "column",
        gap: wide ? "var(--mantine-spacing-xl)" : "var(--mantine-spacing-xs)",
      }}
    >
      <Stack gap={2} style={wide ? { flex: "0 1 auto", maxWidth: "50%", minWidth: 0 } : undefined}>
        {repo && <InfoRow label="Repo">{repo}</InfoRow>}
        {git.branch && (
          <InfoRow label="Branch">
            <Group gap={4} wrap="nowrap" component="span">
              <span>{git.branch}</span>
              <CopyIcon value={git.branch} label="Copy branch name" tooltip="Copy branch name" />
            </Group>
          </InfoRow>
        )}
        <InfoRow label="Working tree">
          <span data-testid="working-tree">
            <Text span inherit c={dirty ? "yellow" : undefined}>{workingSummary(git.working)}</Text>
            {unpushed && (
              <>
                {" "}
                {/* Orange like the badge, but only when it is the whole
                    story: uncommitted changes are the stronger warning and
                    keep the line's color to themselves. */}
                <Text span inherit c={dirty ? undefined : "orange"}>{`(${unpushed})`}</Text>
              </>
            )}
          </span>
        </InfoRow>
        {updated && <InfoRow label="Updated">{relativeTime(updated)}</InfoRow>}
      </Stack>
      <Stack gap={2} style={wide ? { flex: "1 1 0", minWidth: 0 } : undefined}>
        <InfoRow label="Merge base" labelWidth={RIGHT_LABEL_WIDTH}>
          {git.merge_base && git.main_upstream ? (
            <Group gap={4} wrap="nowrap" component="span">
              <span>{`${git.main_upstream} @ ${short}`}</span>
              <CopyIcon value={git.merge_base} label="Copy merge base SHA" tooltip={`Copy ${git.merge_base}`} />
            </Group>
          ) : (
            <Text span inherit c="dimmed">{git.main_upstream ? "unavailable" : "main has no upstream"}</Text>
          )}
        </InfoRow>
        <AheadBehindLine ab={git.vs_merge_base} />
        <InfoRow label="Tracking branch" labelWidth={RIGHT_LABEL_WIDTH}>
          {git.tracking ?? <Text span inherit c="dimmed">none (not pushed)</Text>}
        </InfoRow>
        {git.tracking && <AheadBehindLine ab={git.vs_tracking} />}
        <InfoRow label="Fetched" labelWidth={RIGHT_LABEL_WIDTH}>
          <Group gap={4} wrap="nowrap" component="span">
            <span>{git.fetch.last_ok_at ? relativeTime(git.fetch.last_ok_at) : "never"}</span>
            {git.fetch.last_error && (
              <Tooltip label={git.fetch.last_error} multiline maw={360}>
                <IconAlertTriangle size={12} color="var(--mantine-color-yellow-6)" aria-label="Last fetch failed" />
              </Tooltip>
            )}
          </Group>
        </InfoRow>
      </Stack>
    </Box>
  )
}
