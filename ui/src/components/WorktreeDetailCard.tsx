import { useState } from "react"
import { ActionIcon, Button, Checkbox, Code, Group, Paper, Stack, Tabs, Text, Textarea, Tooltip } from "@mantine/core"
import { IconCheck, IconCopy, IconPencil, IconTrash } from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { api } from "../api/client"
import { useCmuxMatches } from "../api/cmux"
import type { GitStatus, WorktreeSummary } from "../api/types"
import { useWorktreeNotes } from "../hooks/useWorktreeNotes"
import { toggleTaskAt } from "../lib/taskList"
import { relativeTime as rel } from "../lib/relativeTime"
import { DeleteWorktreeModal } from "./DeleteWorktreeModal"
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
 * One meta line, then tabs: Notes (the default) and Environment.
 */
export function WorktreeDetailCard({ w }: { w: WorktreeSummary }) {
  const info = useQuery({
    queryKey: ["worktree-info", w.path],
    queryFn: () => api.worktreeInfo(w.path),
    enabled: !!w.path,
  })
  const notes = useWorktreeNotes(w.path)
  const workspaces = useCmuxMatches(w.path)

  const [, navigate] = useLocation()
  const qc = useQueryClient()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [tab, setTab] = useState<"notes" | "env">("notes")
  const name = w.path.split("/").filter(Boolean).pop() || w.path
  const git = info.data?.git
  const hasEnv = !!info.data && info.data.env.length > 0

  // The Environment tab only exists when there is an environment; if it goes
  // away while selected, fall back to Notes rather than showing no panel.
  const activeTab = tab === "env" && !hasEnv ? "notes" : tab

  // Notes are read-only until "Edit notes", so a stray click or keystroke
  // cannot change them. Leaving the Notes tab ends editing: you always come
  // back to the read-only view.
  const [editing, setEditing] = useState(false)
  const doneEditing = () => {
    notes.flush()
    setEditing(false)
  }

  const selectTab = (next: string | null) => {
    if (next !== "notes" && next !== "env") return
    // Leaving the notes sends pending edits now.
    if (activeTab === "notes" && next !== "notes") doneEditing()
    setTab(next)
  }

  return (
    <Paper p="sm" withBorder>
      {/* The worktree and cmux workspace names live in the page header;
          this card is git state, environment and notes. */}
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
          {[w.repo, git?.branch || w.branch].filter(Boolean).join(" · ")}
          {git && (
            <>
              {" · "}
              <Text span inherit c={git.staged || git.modified || git.untracked ? "yellow" : "dimmed"}>
                {gitSummary(git)}
                {git.upstream ? ` · ${git.upstream}` : ""}
              </Text>
            </>
          )}
          {w.latest_event_ts ? ` · ${rel(w.latest_event_ts)}` : ""}
        </Text>
        <Tooltip label="Delete worktree">
          <ActionIcon
            variant="subtle"
            color="red"
            size="sm"
            aria-label="Delete worktree"
            onClick={() => setDeleteOpen(true)}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Tabs value={activeTab} onChange={selectTab} mt={6}>
        {/* Sized to its tabs, so the underline stops after the last tab. */}
        <Tabs.List w="fit-content">
          <Tabs.Tab value="notes" fz="xs" py={6}>Notes</Tabs.Tab>
          {hasEnv && (
            <Tabs.Tab value="env" fz="xs" py={6}>
              {`Environment (${info.data!.env.length})`}
            </Tabs.Tab>
          )}
        </Tabs.List>

        <Tabs.Panel value="notes" pt={6}>
          <NotesPanel
            notes={notes}
            workspaceCount={workspaces.length}
            editing={editing}
            onEdit={() => setEditing(true)}
            onDone={doneEditing}
          />
        </Tabs.Panel>

        {/*
          The same environment `worktree info` prints. Shown here because it is
          what you need when you open a terminal in this worktree, and it was
          previously only reachable from the CLI.
        */}
        {hasEnv && (
          <Tabs.Panel value="env" pt={6}>
            <Stack gap={2}>
              {info.data!.env.map((kv) => <EnvVarRow key={kv.key} name={kv.key} value={kv.value} />)}
            </Stack>
          </Tabs.Panel>
        )}
      </Tabs>

      {deleteOpen && (
        <DeleteWorktreeModal
          opened
          path={w.path}
          name={name}
          branch={git?.branch || w.branch}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            setDeleteOpen(false)
            // The worktree is gone; the list is the only place left to be.
            void qc.invalidateQueries({ queryKey: ["worktrees"] })
            navigate("/")
          }}
        />
      )}
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
 * The cmux sync checkbox is shown only while editing, so it cannot be toggled
 * by accident either. It is offered only when exactly one cmux workspace
 * matches: with none there is nothing to write to, and with two there is no
 * right answer. If sync was turned on and the count has since changed, it
 * stays visible (so it can be turned off) with a note saying why nothing
 * syncs.
 */
function NotesPanel({ notes, workspaceCount, editing, onEdit, onDone }: {
  notes: ReturnType<typeof useWorktreeNotes>
  workspaceCount: number
  editing: boolean
  onEdit: () => void
  onDone: () => void
}) {
  if (notes.loadError) {
    return <Text size="xs" c="red">Could not load notes: {notes.loadError.message}</Text>
  }
  const showSync = editing && (workspaceCount === 1 || notes.syncCmux)
  return (
    <Stack gap={4}>
      <Group gap="xs" justify="space-between" wrap="wrap" mih={22}>
        <NotesStatus notes={notes} />
        <Group gap="sm">
          {showSync && (
            <Checkbox
              size="xs"
              label="Sync to cmux workspace description"
              checked={notes.syncCmux}
              disabled={!notes.loaded}
              onChange={(e) => notes.setSyncCmux(e.currentTarget.checked)}
            />
          )}
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
        </Group>
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
