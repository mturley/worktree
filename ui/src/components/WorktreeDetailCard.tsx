import { useState } from "react"
import { ActionIcon, Badge, Button, Checkbox, Code, Group, Paper, Stack, Tabs, Text, Textarea, Tooltip } from "@mantine/core"
import { IconCheck, IconCopy, IconPencil, IconX } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import { useCmux, useCmuxMatches } from "../api/cmux"
import type { WorktreeSummary } from "../api/types"
import { isDetailTab, type DetailTab } from "../hooks/useDetailTab"
import { useDiffSelection } from "../hooks/useDiffSelection"
import { useWorktreeGit } from "../hooks/useWorktreeGit"
import { useWorktreeNotes } from "../hooks/useWorktreeNotes"
import { badgeColor, formatBadge } from "../lib/diffLabels"
import { toggleTaskAt } from "../lib/taskList"
import { relativeTime as rel } from "../lib/relativeTime"
import { CmuxPanel } from "./CmuxPanel"
import { DeleteWorktreeButton } from "./DeleteWorktreeButton"
import { GitDiffPanel } from "./gitdiff/GitDiffPanel"
import { NotesMarkdown } from "./NotesMarkdown"
import { KeyHint } from "./search/KeyHint"

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
 * A single row of tabs — Notes, Code, Environment and, inside cmux, cmux —
 * with the delete control at its right. Off Notes, an X before the delete
 * control (or clicking the active tab again) goes back to Notes.
 * The tab is the page's (useDetailTab), because it also decides where the
 * page puts the card: wide, Notes sits in the resource column and the other
 * tabs span the page under the header. Switching between them moves, and so
 * remounts, the card.
 */
export function WorktreeDetailCard({ w, tab, onTabChange, escHint }: {
  w: WorktreeSummary
  tab: DetailTab
  onTabChange: (tab: DetailTab) => void
  /** Show the Esc hint on the Notes tab: the page's next Esc returns to it. */
  escHint?: boolean
}) {
  const info = useQuery({
    queryKey: ["worktree-info", w.path],
    queryFn: () => api.worktreeInfo(w.path),
    enabled: !!w.path,
  })
  const notes = useWorktreeNotes(w.path)
  const workspaces = useCmuxMatches(w.path)

  const cmuxQuery = useCmux()
  const hasCmux = cmuxQuery.data?.available === true
  const git = info.data?.git
  const hasEnv = !!info.data && info.data.env.length > 0
  // Polled whichever tab is showing, so the Code tab's badge is always
  // current. `fetch` only while the Code tab is open: that is when someone is
  // looking at the fetch state and wants it fresh.
  const gitStatus = useWorktreeGit(w.path, { fetch: tab === "code" })
  const { base } = useDiffSelection(w.path, undefined)
  const badge = gitStatus.data?.on_disk ? formatBadge(gitStatus.data, base) : null
  // Yellow for uncommitted changes, orange for unpushed commits, else gray.
  const badgeTint = gitStatus.data?.on_disk ? badgeColor(gitStatus.data) : "gray"
  // Notes are read-only until "Edit notes", so a stray click or keystroke
  // cannot change them. Leaving the Notes tab ends editing: you always come
  // back to the read-only view.
  const [editing, setEditing] = useState(false)
  const doneEditing = () => {
    notes.flush()
    setEditing(false)
  }

  const selectTab = (next: string | null) => {
    if (!isDetailTab(next)) return
    // Leaving the notes sends pending edits now.
    if (tab === "notes" && next !== "notes") doneEditing()
    onTabChange(next)
  }
  // Notes is home: clicking the tab that is already showing goes back to it.
  // Mantine's Tab runs onChange before onClick, so on an inactive tab `tab`
  // is still the previous one here and this does nothing.
  const backToNotesOn = (value: DetailTab) => () => {
    if (tab === value && value !== "notes") selectTab("notes")
  }

  return (
    <Paper p="sm" withBorder>
      <Tabs value={tab} onChange={selectTab} keepMounted={false}>
        {/* The worktree and cmux workspace names live in the page header.
            The tab list is sized to its tabs, so the underline stops after
            the last tab, and the delete control sits at the row's far end. */}
        <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
          <Tabs.List w="fit-content">
            <Tabs.Tab
              value="notes"
              fz="xs"
              py={6}
              rightSection={escHint ? <KeyHint decorative>Esc</KeyHint> : undefined}
            >
              Notes
            </Tabs.Tab>
            <Tabs.Tab
              value="code"
              fz="xs"
              py={6}
              onClick={backToNotesOn("code")}
              rightSection={
                // Badge sets its own default cursor; keep the tab's pointer
                // all the way across it.
                badge ? (
                  <Badge size="xs" variant="light" color={badgeTint} style={{ flex: "none", cursor: "pointer" }}>{badge}</Badge>
                ) : undefined
              }
            >
              Code
            </Tabs.Tab>
            <Tabs.Tab value="env" fz="xs" py={6} onClick={backToNotesOn("env")}>Environment</Tabs.Tab>
            {hasCmux && (
              <Tabs.Tab value="cmux" fz="xs" py={6} onClick={backToNotesOn("cmux")}>cmux</Tabs.Tab>
            )}
          </Tabs.List>
          <Group gap={4} wrap="nowrap">
            {tab !== "notes" && (
              <Tooltip label="Back to notes">
                <ActionIcon variant="subtle" color="gray" aria-label="Back to notes" onClick={() => selectTab("notes")}>
                  <IconX size={16} />
                </ActionIcon>
              </Tooltip>
            )}
            <DeleteWorktreeButton w={w} />
          </Group>
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

        {/* The same environment `worktree info` prints: what you need when
            you open a terminal in this worktree, previously only reachable
            from the CLI. */}
        <Tabs.Panel value="env" pt={6} keepMounted>
          <Stack gap={2}>
            {hasEnv ? (
              info.data!.env.map((kv) => <EnvVarRow key={kv.key} name={kv.key} value={kv.value} />)
            ) : (
              <Text size="xs" c="dimmed" fs="italic">None</Text>
            )}
          </Stack>
        </Tabs.Panel>

        {/* Unmounted when not selected (the Tabs default): that stops the
            panel's fetch nudge and resets its state. The badge on the tab
            label comes from the card's own polled status above. */}
        <Tabs.Panel value="code" pt={6}>
          <GitDiffPanel path={w.path} repo={w.repo} updated={w.latest_event_ts} />
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
 * The notes, read-only (rendered as Markdown) until "Edit notes" swaps in the
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
    <Stack gap={4} mt={4}>
      {/* The notes first, their controls after: the text is what you came
          for, and the Edit notes / Done editing row stays put beneath it. */}
      {editing ? (
        <Textarea
          aria-label="Worktree notes"
          placeholder="What's going on in this worktree? (Markdown)"
          size="xs"
          // Drag the corner to resize. Not Mantine's autosize, which rewrites
          // the height on every keystroke and would undo a drag; instead the
          // row count follows the text (3 to 20 lines), until a drag sets an
          // explicit height that then wins over it.
          resize="vertical"
          rows={Math.min(Math.max(notes.notes.split("\n").length + 1, 3), 20)}
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
      <Group gap="xs" justify="space-between" wrap="wrap" mih={22} mt={6}>
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
            >
              Edit notes
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
