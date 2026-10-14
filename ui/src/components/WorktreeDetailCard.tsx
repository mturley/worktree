import { useEffect, useState, type ReactNode } from "react"
import { ActionIcon, Box, Button, Checkbox, Code, Group, Paper, Stack, Tabs, Text, Textarea, Tooltip } from "@mantine/core"
import { IconArrowBarRight, IconArrowBarToLeft, IconCheck, IconCopy, IconPencil } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import { useCmux, useCmuxMatches } from "../api/cmux"
import type { GitStatus, WorktreeSummary } from "../api/types"
import { useIsWide } from "../hooks/useIsWide"
import { useWorktreeNotes } from "../hooks/useWorktreeNotes"
import { toggleTaskAt } from "../lib/taskList"
import { relativeTime as rel } from "../lib/relativeTime"
import { CmuxPanel } from "./CmuxPanel"
import { NotesMarkdown } from "./NotesMarkdown"

/**
 * Renders a git status as a short line: "3 modified · 1 untracked · ahead 2",
 * or "clean" when the working tree has nothing outstanding.
 *
 * Ahead/behind are reported even when clean, because a branch with unpushed
 * commits is not the same situation as one in sync — a single "dirty" flag
 * would hide that.
 */
function gitSummary(g: GitStatus): string {
  const parts: string[] = []
  if (g.staged) parts.push(`${g.staged} staged`)
  if (g.modified) parts.push(`${g.modified} modified`)
  if (g.untracked) parts.push(`${g.untracked} untracked`)
  if (parts.length === 0) parts.push("clean")
  if (g.ahead) parts.push(`ahead ${g.ahead}`)
  if (g.behind) parts.push(`behind ${g.behind}`)
  return parts.join(" · ")
}

type DetailTab = "notes" | "env" | "cmux"

/**
 * The card's selected tab, remembered per browser tab so switching worktrees
 * keeps it. sessionStorage, like "Follow cmux": a choice for this tab,
 * not for every tab in the browser. Storage throws in some contexts (private
 * windows); the card then just starts on Notes.
 */
const DETAIL_TAB_KEY = "worktree.detailTab"

function readDetailTab(): DetailTab {
  try {
    const v = window.sessionStorage.getItem(DETAIL_TAB_KEY)
    if (v === "env" || v === "cmux") return v
  } catch {
    // fall through
  }
  return "notes"
}

function writeDetailTab(tab: DetailTab): void {
  try {
    window.sessionStorage.setItem(DETAIL_TAB_KEY, tab)
  } catch {
    // not remembered; the selection still applies to this card
  }
}

/**
 * The details card under the worktree detail page's header.
 *
 * Deliberately NOT the same component as the home page's WorktreeCard. That
 * card lists the worktree's focus resources, which here would duplicate the
 * resource cards immediately below it. This one answers the questions you
 * actually have while working IN a worktree instead: what is my environment,
 * what branch am I on, is the tree dirty, when did anything last happen, and
 * what was I in the middle of (notes).
 *
 * A single row of tabs — Notes, Git / Environment and, inside cmux, cmux.
 * Opens on the tab last chosen
 * in this browser tab (Notes the first time).
 *
 * Two placements, chosen by the page: expanded, under the header across the
 * full width, or collapsed into the resource column above Follow resource, so
 * the activity column gets the height back. The card only draws the toggle
 * (`onToggleCollapsed`); the page moves it. Moving it remounts it, so the
 * toggle sends any pending notes edit first.
 */
export function WorktreeDetailCard({ w, collapsed = false, onToggleCollapsed }: {
  w: WorktreeSummary
  collapsed?: boolean
  /** Omitted where only one placement exists (narrow): no toggle is drawn. */
  onToggleCollapsed?: () => void
}) {
  const info = useQuery({
    queryKey: ["worktree-info", w.path],
    queryFn: () => api.worktreeInfo(w.path),
    enabled: !!w.path,
  })
  const notes = useWorktreeNotes(w.path)
  const workspaces = useCmuxMatches(w.path)

  const [tab, setTab] = useState<DetailTab>(readDetailTab)
  const cmuxQuery = useCmux()
  const hasCmux = cmuxQuery.data?.available === true
  const git = info.data?.git
  const hasEnv = !!info.data && info.data.env.length > 0
  // Expanded across a wide page, git state and the environment sit side by
  // side rather than leaving most of the card's width empty. Collapsed into
  // the side column, or on a phone, there is no room for two.
  const envSideBySide = useIsWide() && !collapsed

  // The cmux tab only exists inside cmux; if it is selected and goes away,
  // fall back to Notes rather than showing no panel.
  const activeTab = tab === "cmux" && !hasCmux ? "notes" : tab

  // The fallback above is a per-render display computation, not a stored
  // selection: without this, `tab` itself would still say "cmux", so the
  // moment cmux reappears (a transient blip, a 5s poll) the card would jump
  // straight back to it instead of staying on Notes.
  //
  // Only once the data has actually said the tab is gone, though: before it
  // loads, a remembered tab (see readDetailTab) is waiting to be shown, not
  // missing. And never written back to sessionStorage — this tab being
  // gone for now says nothing about the next card.
  const absenceKnown = tab === "cmux" && cmuxQuery.data !== undefined
  useEffect(() => {
    if (activeTab !== tab && absenceKnown) setTab(activeTab)
  }, [activeTab, tab, absenceKnown])

  // Notes are read-only until "Edit", so a stray click or keystroke
  // cannot change them. Leaving the Notes tab ends editing: you always come
  // back to the read-only view.
  const [editing, setEditing] = useState(false)
  const doneEditing = () => {
    notes.flush()
    setEditing(false)
  }

  const selectTab = (next: string | null) => {
    if (next !== "notes" && next !== "env" && next !== "cmux") return
    // Leaving the notes sends pending edits now.
    if (activeTab === "notes" && next !== "notes") doneEditing()
    setTab(next)
    writeDetailTab(next)
  }

  return (
    <Paper p="sm" withBorder>
      <Tabs value={activeTab} onChange={selectTab} keepMounted={false}>
        {/* The worktree and cmux workspace names, the Hide details toggle and
            the delete control all live in the page header. Sized to its tabs,
            so the underline stops after the last tab. */}
        <Group justify="space-between" wrap="nowrap" align="center" gap="xs">
          <Tabs.List w="fit-content">
            <Tabs.Tab value="notes" fz="xs" py={6}>Notes</Tabs.Tab>
            <Tabs.Tab value="env" fz="xs" py={6}>Git / Environment</Tabs.Tab>
            {hasCmux && (
              <Tabs.Tab value="cmux" fz="xs" py={6}>cmux</Tabs.Tab>
            )}
          </Tabs.List>
          {onToggleCollapsed && (
            <Tooltip label={collapsed ? "Expand details" : "Collapse details into the side column"}>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={collapsed ? "Expand details" : "Collapse details"}
                aria-pressed={collapsed}
                onClick={() => {
                  if (editing) doneEditing()
                  onToggleCollapsed()
                }}
                style={{ flexShrink: 0 }}
              >
                {collapsed ? <IconArrowBarRight size={14} /> : <IconArrowBarToLeft size={14} />}
              </ActionIcon>
            </Tooltip>
          )}
        </Group>

        <Tabs.Panel value="notes" pt={6} keepMounted>
          <NotesPanel
            notes={notes}
            workspaceCount={workspaces.length}
            hasCmux={hasCmux}
            editing={editing}
            onEdit={() => setEditing(true)}
            onDone={doneEditing}
          />
        </Tabs.Panel>

        {/*
          Git state, then the same environment `worktree info` prints: what
          you need when you open a terminal in this worktree, previously only
          reachable from the CLI. Repo and branch come from the summary, so
          they show even when the info request fails.
        */}
        <Tabs.Panel value="env" pt={6} keepMounted>
          {/* Side by side, the git column takes only the width it needs (up to
              a cap, for a long branch name) and the environment, whose values
              are long paths and URLs, takes the rest. */}
          <Box
            style={{
              display: "flex",
              flexDirection: envSideBySide ? "row" : "column",
              gap: envSideBySide ? "var(--mantine-spacing-xl)" : "var(--mantine-spacing-xs)",
            }}
          >
            <Stack gap={2} style={envSideBySide ? { flex: "0 1 auto", maxWidth: "40%", minWidth: 0 } : undefined}>
              {w.repo && <InfoRow label="Repo">{w.repo}</InfoRow>}
              {(git?.branch || w.branch) && <InfoRow label="Branch">{git?.branch || w.branch}</InfoRow>}
              {git && (
                <InfoRow label="Status">
                  <Text span inherit c={git.staged || git.modified || git.untracked ? "yellow" : undefined}>
                    {gitSummary(git)}
                  </Text>
                </InfoRow>
              )}
              {git?.upstream && <InfoRow label="Upstream">{git.upstream}</InfoRow>}
              {w.latest_event_ts && <InfoRow label="Updated">{rel(w.latest_event_ts)}</InfoRow>}
            </Stack>
            <Stack gap={2} style={envSideBySide ? { flex: "1 1 0", minWidth: 0 } : undefined}>
              <SectionLabel>Environment</SectionLabel>
              {hasEnv ? (
                info.data!.env.map((kv) => <EnvVarRow key={kv.key} name={kv.key} value={kv.value} />)
              ) : (
                <Text size="xs" c="dimmed" fs="italic">None</Text>
              )}
            </Stack>
          </Box>
        </Tabs.Panel>

        {/*
          Unmounted when not selected (keepMounted is off for this panel
          only): that stops its 5s poll and resets its expanded tab groups.
        */}
        {hasCmux && (
          <Tabs.Panel value="cmux" pt={6}>
            <CmuxPanel path={w.path} branch={git?.branch || w.branch} />
          </Tabs.Panel>
        )}
      </Tabs>
    </Paper>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <Text size="xs" fw={600} tt="uppercase" c="dimmed">{children}</Text>
}

/** One labelled line of git state: "Branch   my-branch". */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="xs" c="dimmed" w={70} style={{ flex: "none" }}>{label}</Text>
      <Text size="xs" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{children}</Text>
    </Group>
  )
}

const COPIED_FEEDBACK_MS = 1500

/** One environment variable, with a button that copies its value. */
function EnvVarRow({ name, value }: { name: string; value: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    } catch {
      // Clipboard access can be denied; the value is still selectable.
    }
  }

  return (
    <Group gap={4} wrap="nowrap" align="flex-start">
      <Text size="xs" style={{ overflowWrap: "anywhere" }}>
        <Text span c="dimmed">{name}=</Text>
        <Code>{value}</Code>
      </Text>
      <Tooltip label={copied ? "Copied" : "Copy value"}>
        <ActionIcon
          variant="subtle"
          color={copied ? "teal" : "gray"}
          size="xs"
          aria-label={`Copy ${name}`}
          onClick={copy}
          style={{ flexShrink: 0 }}
        >
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}

/**
 * The notes, read-only (rendered as Markdown) until "Edit" swaps in the
 * textarea. Task checkboxes stay clickable in the read-only view — a targeted
 * edit to that one marker, saved immediately, like a GitHub description. Editing auto-saves as before; "Done editing" (or Esc) sends any
 * pending edit and returns to the read-only view.
 *
 * The "Show notes on home page" and cmux sync checkboxes are shown only while
 * editing, so they cannot be toggled by accident either. The sync one is offered only when exactly one cmux workspace
 * matches: with none there is nothing to write to, and with two there is no
 * right answer. If sync was turned on and the count has since changed, it
 * stays visible (so it can be turned off) with a note saying why nothing
 * syncs. Outside cmux, or with cmux features off in Settings, it is hidden
 * entirely: the server skips the sync then, and "no cmux workspace" would be
 * the wrong reason.
 */
function NotesPanel({ notes, workspaceCount, hasCmux, editing, onEdit, onDone }: {
  notes: ReturnType<typeof useWorktreeNotes>
  workspaceCount: number
  hasCmux: boolean
  editing: boolean
  onEdit: () => void
  onDone: () => void
}) {
  if (notes.loadError) {
    return <Text size="xs" c="red">Could not load notes: {notes.loadError.message}</Text>
  }
  const showSync = editing && hasCmux && (workspaceCount === 1 || notes.syncCmux)
  return (
    <Stack gap={4}>
      <Group gap="xs" justify="space-between" wrap="wrap" mih={22}>
        <Group gap="xs" wrap="wrap">
          {editing ? (
            <Button size="compact-xs" variant="light" leftSection={<IconCheck size={12} />} onClick={onDone}>
              Done editing
            </Button>
          ) : (
            <Button
              size="compact-xs"
              variant="subtle"
              leftSection={<IconPencil size={12} />}
              disabled={!notes.loaded}
              onClick={onEdit}
              // Visibly just "Edit" to save room in the row; the card's tab
              // already says what is being edited, a screen reader's list of
              // buttons does not.
              aria-label="Edit notes"
            >
              Edit
            </Button>
          )}
          <NotesStatus notes={notes} />
        </Group>
        {editing && (
          // Wide apart side by side, but close once they wrap onto two lines.
          <Group gap="md" wrap="wrap" style={{ rowGap: 4 }}>
            <Checkbox
              size="xs"
              label="Show notes on home page"
              checked={notes.showOnHome}
              disabled={!notes.loaded}
              onChange={(e) => notes.setShowOnHome(e.currentTarget.checked)}
            />
            {showSync && (
              <Checkbox
                size="xs"
                label="Sync to cmux workspace description"
                checked={notes.syncCmux}
                disabled={!notes.loaded}
                onChange={(e) => notes.setSyncCmux(e.currentTarget.checked)}
              />
            )}
          </Group>
        )}
      </Group>
      {showSync && notes.syncCmux && workspaceCount !== 1 && (
        <Text size="xs" c="yellow">
          {workspaceCount === 0
            ? "Not syncing: this worktree has no cmux workspace."
            : `Not syncing: this worktree has ${workspaceCount} cmux workspaces.`}
        </Text>
      )}
      {editing ? (
        <Textarea
          aria-label="Worktree notes"
          placeholder="What's going on in this worktree? (Markdown)"
          size="xs"
          mt={6}
          autosize
          minRows={3}
          autoFocus
          value={notes.notes}
          onChange={(e) => notes.setNotes(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              onDone()
            }
          }}
        />
      ) : notes.notes.trim() ? (
        <NotesMarkdown
          text={notes.notes}
          onToggleTask={(offset) => notes.editNotes((text) => toggleTaskAt(text, offset))}
        />
      ) : (
        <Text size="xs" c="dimmed" fs="italic">No notes yet</Text>
      )}
    </Stack>
  )
}

function NotesStatus({ notes }: { notes: ReturnType<typeof useWorktreeNotes> }) {
  const retry = (
    <Button size="compact-xs" variant="light" onClick={notes.retry}>
      Retry
    </Button>
  )
  switch (notes.status) {
    case "unsaved":
      return <Text size="xs" c="dimmed">Unsaved changes</Text>
    case "saving":
      return <Text size="xs" c="dimmed">Saving…</Text>
    case "error":
      return (
        <Group gap="xs">
          <Text size="xs" c="red">Save failed{notes.error ? `: ${notes.error}` : ""}</Text>
          {retry}
        </Group>
      )
    case "saved":
      if (notes.cmux?.outcome === "failed") {
        return (
          <Group gap="xs">
            <Tooltip label={notes.cmux.error} disabled={!notes.cmux.error}>
              <Text size="xs" c="yellow">Saved · cmux sync failed</Text>
            </Tooltip>
            {retry}
          </Group>
        )
      }
      return (
        <Text size="xs" c="dimmed">
          {notes.cmux?.outcome === "ok" ? "Saved · synced to cmux" : "Saved"}
        </Text>
      )
    default:
      return (
        <Text size="xs" c="dimmed">
          {notes.updatedAt ? `Saved ${rel(notes.updatedAt)}` : ""}
        </Text>
      )
  }
}
